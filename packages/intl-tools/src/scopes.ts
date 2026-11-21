// Lexical binding resolution for the extractor: one pass declares every name in the scope JavaScript gives it
// (function, block, loop head, catch, class, switch; `var` hoisted to its function body or static block), so a name
// resolves to the declaration it really refers to, whatever shadows it on the way. Each expression resolves in the
// environment JavaScript evaluates it in: parameters (and their defaults) outside the function body's `var`s, a
// switch's discriminant outside its cases. Translators, package imports and `Fragment` all resolve through it.
import type {
  BindingPattern,
  Node,
  ObjectPattern,
  ParamPattern,
  Program,
  VariableDeclarator,
} from "oxc-parser";

import { childNodes } from "./ast-children.ts";

/** How a name was declared. */
export type Declaration =
  | {
      readonly _tag: "Import";
      /** The module specifier. */
      readonly source: string;
      /** The imported name: `default` for a default import, `*` for a namespace import. */
      readonly imported: string;
    }
  | {
      readonly _tag: "Variable";
      readonly constant: boolean;
      readonly declarator: VariableDeclarator;
      /**
       * Where the name sits in the declarator's pattern: the whole `id` (`const x = …`), a top-level object-pattern
       * property (`const { t: x = d } = …` binds `x` at that property's key), or anywhere deeper.
       */
      readonly position:
        | { readonly _tag: "Id" }
        | { readonly _tag: "TopLevelKey"; readonly property: PatternProperty }
        | { readonly _tag: "Nested" };
      /** The scope the declaration is written in, where its initializer's names resolve (not where `var` hoists). */
      readonly site: Scope;
    }
  /** A function or catch parameter: its value comes from the caller. */
  | { readonly _tag: "Parameter" }
  /** A function or class declaration's name. */
  | { readonly _tag: "Local" };

/** A property of an object binding pattern. */
export type PatternProperty = Extract<ObjectPattern["properties"][number], { readonly type: "Property" }>;

/** A declared name: every declaration of it in one scope (`var` may repeat). */
export type Binding = { readonly declarations: Array<Declaration> };

/** A lexical scope. */
export type Scope = {
  readonly parent: Scope | undefined;
  /** Function bodies, static blocks and the module receive `var` declarations. */
  readonly hoistsVar: boolean;
  readonly bindings: Map<string, Binding>;
};

/** The scopes of one program. */
export type ScopeTree = {
  readonly root: Scope;
  /** The scope a scope-creating node opens; `undefined` for any other node. */
  readonly scopeOf: (node: Node) => Scope | undefined;
};

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const SCOPE_TYPES = new Set([
  ...FUNCTION_TYPES,
  "BlockStatement",
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "CatchClause",
  "ClassDeclaration",
  "ClassExpression",
]);
// Scopes that receive `var` declarations besides a function's body (the module root is one too).
const VAR_SCOPE_TYPES = new Set(["StaticBlock"]);

/**
 * Declare every name of a program in its lexical scope.
 *
 * @param program - The program (module code: strict, so function declarations are block-scoped).
 * @returns The scope tree.
 */
export function analyzeScopes(program: Program): ScopeTree {
  const root = newScope(undefined, true);
  const scopes = new Map<Node, Scope>();
  const declare = (scope: Scope, name: string, declaration: Declaration): void => {
    const binding = scope.bindings.get(name);

    if (binding) {
      binding.declarations.push(declaration);
    } else {
      scope.bindings.set(name, { declarations: [declaration] });
    }
  };
  const declarePattern = (scope: Scope, pattern: BindingPattern | ParamPattern): void => {
    for (const name of patternNames(pattern)) {
      declare(scope, name, { _tag: "Parameter" });
    }
  };
  // Function bodies: their own scope receives `var`s, so a body `var` never shadows a name in a parameter default.
  const bodies = new Set<Node>();
  const walk = (node: Node, scope: Scope): void => {
    // The cases share one block scope; the discriminant is evaluated before it exists.
    if (node.type === "SwitchStatement") {
      walk(node.discriminant, scope);
      const cases = newScope(scope, false);
      for (const switchCase of node.cases) {
        scopes.set(switchCase, cases);
        for (const child of childNodes(switchCase)) {
          walk(child, cases);
        }
      }

      return;
    }

    const opened = SCOPE_TYPES.has(node.type)
      ? newScope(scope, bodies.has(node) || VAR_SCOPE_TYPES.has(node.type))
      : undefined;

    if (opened) {
      scopes.set(node, opened);
    }

    const inner = opened ?? scope;
    switch (node.type) {
      case "ImportDeclaration":
        for (const specifier of node.specifiers) {
          const imported =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value
              : specifier.type === "ImportDefaultSpecifier"
                ? "default"
                : "*";
          declare(scope, specifier.local.name, { _tag: "Import", source: node.source.value, imported });
        }
        break;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? hoistTarget(scope) : scope;
        for (const declarator of node.declarations) {
          for (const [name, position] of declaratorNames(declarator)) {
            declare(target, name, {
              _tag: "Variable",
              constant: node.kind === "const",
              declarator,
              position,
              site: scope,
            });
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) {
          // A declaration's name lives where it is written; a function expression's name only inside itself.
          declare(node.type === "FunctionDeclaration" ? scope : inner, node.id.name, { _tag: "Local" });
        }

        node.params.forEach((param) => {
          declarePattern(inner, param);
        });

        if (node.body?.type === "BlockStatement") {
          bodies.add(node.body);
        }

        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) {
          declare(node.type === "ClassDeclaration" ? scope : inner, node.id.name, { _tag: "Local" });
        }

        break;
      case "CatchClause":
        if (node.param) {
          declarePattern(inner, node.param);
        }

        break;
      default:
        break;
    }

    for (const child of childNodes(node)) {
      walk(child, inner);
    }
  };
  for (const statement of program.body) {
    walk(statement, root);
  }

  return { root, scopeOf: (node) => scopes.get(node) };
}

/**
 * The binding a name refers to from a scope.
 *
 * @param scope - Where the name is used.
 * @param name - The name.
 * @returns Its binding, or `undefined` for a global.
 */
export function resolveName(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);

    if (binding) {
      return binding;
    }
  }

  return undefined;
}

function newScope(parent: Scope | undefined, hoistsVar: boolean): Scope {
  return { parent, hoistsVar, bindings: new Map() };
}

function hoistTarget(scope: Scope): Scope {
  let current = scope;
  while (!current.hoistsVar && current.parent) {
    current = current.parent;
  }

  return current;
}

type Position = Extract<Declaration, { readonly _tag: "Variable" }>["position"];

function declaratorNames(declarator: VariableDeclarator): Array<readonly [string, Position]> {
  const { id } = declarator;

  if (id.type === "Identifier") {
    return [[id.name, { _tag: "Id" }]];
  }

  if (id.type !== "ObjectPattern") {
    return patternNames(id).map((name) => [name, { _tag: "Nested" }] as const);
  }

  return id.properties.flatMap((property): Array<readonly [string, Position]> => {
    if (property.type === "RestElement") {
      return patternNames(property.argument).map((name) => [name, { _tag: "Nested" }] as const);
    }

    const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value;

    if (value.type === "Identifier") {
      return [[value.name, { _tag: "TopLevelKey", property }] as const];
    }

    return patternNames(value).map((name) => [name, { _tag: "Nested" }] as const);
  });
}

/**
 * The names a binding or assignment-target pattern writes (member targets write no name).
 *
 * @param pattern - A declaration, parameter or assignment-target pattern.
 * @returns The written names.
 */
function patternNames(pattern: BindingPattern | ParamPattern | Node): Array<string> {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === "RestElement" ? property.argument : property.value)
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element ? patternNames(element) : []));
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    case "TSParameterProperty":
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}
