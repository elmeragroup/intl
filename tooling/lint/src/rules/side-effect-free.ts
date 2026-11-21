// The published packages declare `"sideEffects": false`, so a bundler may drop any module whose exports go unused.
// That is sound only if importing a module does nothing but define things. The rule evaluates everything a module
// runs at import and accepts only what it can prove runs no effect; anything else needs `/* @__PURE__ */`, the
// annotation bundlers read to drop an unused call, which is then the author's claim (callbacks included). At the top
// level of a published package's src:
//
// - imports with bindings, exports and directives are allowed; a bare `import "x"` exists only for its effect;
// - function, type, interface and `declare` declarations run nothing;
// - a class runs its `extends` expression, decorators, computed keys (static or not) and static field initializers at
//   definition, so each must be pure, and a static block is reported; method bodies and instance fields run later;
// - a variable runs its initializer and its binding pattern: every default and computed key, at any depth;
// - a pure expression is a literal, an identifier or member read, a function or arrow (a value until called), an
//   array, object, template, operator (not `delete`) or TypeScript wrapper of pure parts, or a pure class; a call or
//   `new` is pure only when it is annotated, or names a global below that only builds a value, with pure arguments.
//   A global counts only when no binding in scope shadows it.
//
// The list is short on purpose: a global that takes a function (`Array.from`'s map) or reads an object's methods
// (`String(x)`) can run caller code, so it is annotated where it is used instead.
import type { ESTree, Rule } from "@oxlint/plugins";

import { dottedName, isGlobalName, unwrap } from "../ast.ts";
import { isPublishedSource, packageOf } from "../workspace.ts";

// Constructors that only build a value from their arguments.
const PURE_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "Intl.DateTimeFormat",
  "Intl.ListFormat",
  "Intl.NumberFormat",
  "Intl.PluralRules",
  "Intl.RelativeTimeFormat",
]);

// Functions that only build a value from primitive arguments.
const PURE_FUNCTIONS = new Set(["Symbol", "Date.UTC"]);

const PURE_ANNOTATION = /^[#@]__PURE__$/u;

/** Reports a top-level statement or initializer in a published module that runs an effect at import. */
export const sideEffectFree: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Published modules only define things at import, as `sideEffects: false` promises.",
    },
    messages: {
      statement:
        'This statement runs when the module is imported, but the package declares `"sideEffects": false`, so a bundler may drop the module and the effect with it. Move it into a function the caller runs.',
      bareImport:
        '`import "{{specifier}}"` exists only for its side effect, which `"sideEffects": false` lets a bundler drop. Import a binding, or call an exported setup function.',
      impure:
        "This may run an effect when the module is imported (`sideEffects: false` lets a bundler drop it). Compute it lazily, or mark a call that only builds a value `/* @__PURE__ */`.",
      staticBlock:
        "A static block runs when the module is imported (`sideEffects: false`). Initialize lazily instead.",
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);

    if (pkg === undefined || !isPublishedSource(pkg, context.filename)) {
      return {};
    }

    const { sourceCode } = context;

    function annotatedPure(node: ESTree.Node): boolean {
      return sourceCode
        .getCommentsBefore(node)
        .some((comment) => comment.type === "Block" && PURE_ANNOTATION.test(comment.value.trim()));
    }

    // A callee from the list, read through scope: `Map` and `Intl.PluralRules` count only as the globals.
    function isTrustedGlobal(callee: ESTree.Expression, list: ReadonlySet<string>): boolean {
      const name = dottedName(callee);
      const root = name?.split(".")[0];

      return (
        name !== undefined &&
        root !== undefined &&
        list.has(name) &&
        isGlobalName(sourceCode.getScope(callee), root)
      );
    }

    function isPure(node: ESTree.Node | null): boolean {
      if (node === null) {
        return true;
      }

      switch (node.type) {
        case "Literal":
        case "Identifier":
        case "ThisExpression":
        case "MetaProperty":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          return true;
        case "TemplateLiteral":
          return node.expressions.every((expression) => isPure(expression));
        case "MemberExpression":
          return isPure(node.object) && (!node.computed || isPure(node.property));
        case "ArrayExpression":
          return node.elements.every((element) => isPure(element));
        case "SpreadElement":
          return isPure(node.argument);
        case "ObjectExpression":
          return node.properties.every((property) =>
            property.type === "SpreadElement"
              ? isPure(property.argument)
              : (!property.computed || isPure(property.key)) && isPure(property.value)
          );
        case "UnaryExpression":
          return node.operator !== "delete" && isPure(node.argument);
        case "BinaryExpression":
        case "LogicalExpression":
          return isPure(node.left) && isPure(node.right);
        case "ConditionalExpression":
          return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
        case "ParenthesizedExpression":
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSNonNullExpression":
        case "TSTypeAssertion":
        case "TSInstantiationExpression":
          return isPure(unwrap(node));
        case "ClassExpression":
          return isPureClass(node);
        case "NewExpression":
        case "CallExpression": {
          const arguments_ = node.arguments.every((argument) => isPure(argument));

          if (annotatedPure(node)) {
            return arguments_;
          }

          const list = node.type === "NewExpression" ? PURE_CONSTRUCTORS : PURE_FUNCTIONS;

          return node.callee.type !== "Super" && isTrustedGlobal(unwrap(node.callee), list) && arguments_;
        }
        default:
          return false;
      }
    }

    // What destructuring runs: each default and each computed key, at any depth.
    function isPurePattern(pattern: ESTree.Node): boolean {
      switch (pattern.type) {
        case "Identifier":
          return true;
        case "ObjectPattern":
          return pattern.properties.every((property) =>
            property.type === "RestElement"
              ? isPurePattern(property.argument)
              : (!property.computed || isPure(property.key)) && isPurePattern(property.value)
          );
        case "ArrayPattern":
          return pattern.elements.every((element) => element === null || isPurePattern(element));
        case "RestElement":
          return isPurePattern(pattern.argument);
        case "AssignmentPattern":
          return isPurePattern(pattern.left) && isPure(pattern.right);
        default:
          return false;
      }
    }

    function isPureClass(node: ESTree.Class): boolean {
      if (node.decorators.length > 0 || (node.superClass !== null && !isPure(node.superClass))) {
        return false;
      }

      return node.body.body.every((member) => {
        if (member.type === "StaticBlock") {
          context.report({ node: member, messageId: "staticBlock" });

          return true;
        }

        if ("decorators" in member && member.decorators.length > 0) {
          return false;
        }

        if ("computed" in member && member.computed && !isPure(member.key)) {
          return false;
        }

        return member.type !== "PropertyDefinition" || !member.static || isPure(member.value);
      });
    }

    function checkDeclaration(declaration: ESTree.Node): void {
      switch (declaration.type) {
        case "VariableDeclaration":
          for (const declarator of declaration.declarations) {
            if (!isPurePattern(declarator.id)) {
              context.report({ node: declarator.id, messageId: "impure" });
            } else if (declarator.init !== null && !isPure(declarator.init)) {
              context.report({ node: declarator.init, messageId: "impure" });
            }
          }

          return;
        case "ClassDeclaration":
          if (!isPureClass(declaration)) {
            context.report({ node: declaration, messageId: "statement" });
          }

          break;
        case "FunctionDeclaration":
        case "TSTypeAliasDeclaration":
        case "TSInterfaceDeclaration":
        case "TSDeclareFunction":
        case "TSModuleDeclaration":
        case "TSEnumDeclaration":
          return;
        default:
          context.report({ node: declaration, messageId: "statement" });
      }
    }

    return {
      Program(program) {
        for (const statement of program.body) {
          switch (statement.type) {
            case "ImportDeclaration":
              if (statement.specifiers.length === 0 && statement.importKind !== "type") {
                context.report({
                  node: statement,
                  messageId: "bareImport",
                  data: { specifier: statement.source.value },
                });
              }

              break;
            case "ExportAllDeclaration":
              break;
            case "ExportNamedDeclaration":
              if (statement.declaration) {
                checkDeclaration(statement.declaration);
              }

              break;
            case "ExportDefaultDeclaration": {
              const { declaration } = statement;

              if (declaration.type === "ClassDeclaration" || declaration.type === "FunctionDeclaration") {
                checkDeclaration(declaration);
              } else if (declaration.type !== "TSInterfaceDeclaration" && !isPure(declaration)) {
                context.report({ node: declaration, messageId: "impure" });
              }

              break;
            }
            case "ExpressionStatement":
              if (statement.directive === null) {
                context.report({ node: statement, messageId: "statement" });
              }

              break;
            default:
              checkDeclaration(statement);
          }
        }
      },
    };
  },
};
