// The deny-by-default extractor. It reads the JSX compiler's output, so entities and JSX text rules come from a real
// compiler, and resolves bindings by import source, not by name. Anything it cannot resolve is a failure that names
// the fix, never a silent skip. The CLI and the lint rule both run it, so they cannot disagree.
import type { CallExpression, Node, Program, VariableDeclarator } from "oxc-parser";
import { parseSync } from "oxc-parser";
import { transformSync } from "oxc-transform";

import { keyOf } from "@elmeragroup/intl/internal/message";

import { childNodes } from "./ast-children.ts";
import type { Import, Kind, Origin } from "./bindings.ts";
import {
  AWAIT_TRANSPARENT,
  Bindings,
  isPackageSpecifier,
  keyName,
  unwrap,
  VALUE_TRANSPARENT,
} from "./bindings.ts";
import type { MessageReader, StaticName, StaticValueOf } from "./extract-message.ts";
import { extractMsg, extractT, literalValue, propertyKey, stringValue } from "./extract-message.ts";
import type { Scope, ScopeTree } from "./scopes.ts";
import { analyzeScopes, resolveName } from "./scopes.ts";
import type { SourcePosition } from "./source-position.ts";
import { createSourceMapper, positionAt } from "./source-position.ts";

/** A message found in a source file. */
export type ExtractedMessage = {
  /** `keyOf(source, context)`. */
  readonly key: string;
  /** The serialized English ICU source. */
  readonly source: string;
  /** The literal context, if any. */
  readonly context: string | undefined;
  /** What each positional tag stands for (`<x0> = <a href>`), for translators. */
  readonly tags: ReadonlyArray<string>;
};

/** A use of the package the extractor cannot resolve. */
export type ExtractFailure = {
  readonly _tag: "ExtractFailure";
  /** What is wrong and how to write it instead. */
  readonly message: string;
  /** Where, in the source as written. */
  readonly position: SourcePosition;
};

/** The outcome of extracting one file. */
export type ExtractResult =
  | { readonly _tag: "Extracted"; readonly messages: ReadonlyArray<ExtractedMessage> }
  | { readonly _tag: "Failed"; readonly failures: ReadonlyArray<ExtractFailure> };

const JSX_RUNTIMES = new Set(["react/jsx-runtime", "react/jsx-dev-runtime"]);
const HOOK_NAME = /^use[A-Z]/u;
// Only t-returning factories must be bound: a bare t is called by name, so a wrapper would hide it. IntlInstance objects
// may flow, but a `.t(…)` call on one the file cannot trace to its factory fails.
const T_FACTORIES = ["useT", "getT"];
// Components whose meaning is their JSX children: called as functions, their message is invisible.
const JSX_ONLY = new Set(["T", "Val", "Plural", "Select"]);

/**
 * Extract the messages of one source file, or every reason it cannot be extracted.
 *
 * @param filename - The file's path; its extension picks the parser (`.ts`, `.tsx`, `.js`, `.jsx`, ...).
 * @param code - The file's source text.
 * @returns The messages in source order, or the failures with their source positions.
 * @throws When oxc returns no source map although asked for one (a defect).
 */
export function extractMessages(filename: string, code: string): ExtractResult {
  const compiled = transformSync(filename, code, {
    jsx: { runtime: "automatic" },
    typescript: {},
    sourcemap: true,
  });
  const [syntaxError] = compiled.errors;

  if (syntaxError !== undefined) {
    const offset = syntaxError.labels[0]?.start ?? 0;

    return {
      _tag: "Failed",
      failures: [
        {
          _tag: "ExtractFailure",
          message: `cannot parse: ${syntaxError.message}`,
          position: positionAt(code, offset),
        },
      ],
    };
  }

  if (compiled.map === undefined) {
    throw new Error(`oxc-transform returned no source map for ${filename}`);
  }

  const { program } = parseSync(filename.replace(/\.[cm]?[jt]sx?$/u, ".js"), compiled.code);
  // Type-only imports are erased by the compiler, so whether a file uses the package is read from the source.
  const importsPackage = importsPackageIn(parseSync(filename, code).program);
  const toSource = createSourceMapper(compiled.map.mappings);
  const sourcePosition = (offset: number) =>
    toSource(positionAt(compiled.code, offset)) ?? { line: 1, column: 0 };
  const extraction = new Extraction(importsPackage, compiled.code, analyzeScopes(program));
  extraction.run(program);

  if (extraction.failures.length > 0) {
    const seen = new Set<string>();
    const failures = extraction.failures.flatMap(({ message, offset }) => {
      const position = sourcePosition(offset);
      const id = `${position.line}:${position.column}:${message}`;

      if (seen.has(id)) {
        return [];
      }

      seen.add(id);

      return [{ _tag: "ExtractFailure" as const, message, position }];
    });

    return { _tag: "Failed", failures };
  }

  return { _tag: "Extracted", messages: extraction.messages };
}

// Whether the source imports the package, by the specifier's value (an escape spells the same module).
function importsPackageIn(program: Program): boolean {
  return program.body.some(
    (statement) => statement.type === "ImportDeclaration" && isPackageSpecifier(statement.source.value)
  );
}

type Use = { readonly parent: Node | undefined; readonly child: Node | undefined };
type PendingFailure = { readonly message: string; readonly offset: number };

// One file's walk. Names resolve through the scope tree; the walk itself only tracks where it is (current scope,
// ancestors) and collects messages and failures.
class Extraction {
  readonly messages: Array<ExtractedMessage> = [];
  readonly failures: Array<PendingFailure> = [];
  private readonly bindings = new Bindings();
  private readonly ancestors: Array<Node> = [];
  private scope: Scope;

  private readonly importsPackage: boolean;
  private readonly code: string;
  private readonly tree: ScopeTree;

  constructor(importsPackage: boolean, code: string, tree: ScopeTree) {
    this.importsPackage = importsPackage;
    this.code = code;
    this.tree = tree;
    this.scope = tree.root;
  }

  run(program: Program): void {
    for (const statement of program.body) {
      this.checkReexport(statement);
      this.visit(statement, program);
    }
  }

  private fail(node: Node, message: string): void {
    this.failures.push({ message, offset: node.start });
  }

  private checkReexport(statement: Node): void {
    if (
      (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
      statement.source &&
      isPackageSpecifier(statement.source.value)
    ) {
      this.fail(
        statement,
        "re-exporting the intl package hides call sites from extraction; import it directly"
      );
    }

    if (statement.type === "ImportDeclaration" && isPackageSpecifier(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          this.fail(specifier, "`import * as` the intl package is not extractable; use named imports");
        }
      }
    }
  }

  private importOf(node: Node | null | undefined): Import | undefined {
    return this.bindings.importOf(node, this.scope);
  }

  private packageImport(node: Node | null | undefined): string | undefined {
    const imported = this.importOf(node);

    return imported && isPackageSpecifier(imported.source) ? imported.imported : undefined;
  }

  private isPackageBinding(node: Node | null | undefined, name: string): boolean {
    return this.packageImport(node) === name;
  }

  private isFragment(type: Node): boolean {
    const imported = this.importOf(type);

    if (imported) {
      return (
        imported.imported === "Fragment" && (imported.source === "react" || JSX_RUNTIMES.has(imported.source))
      );
    }

    const namespace = type.type === "MemberExpression" ? this.importOf(type.object) : undefined;

    return (
      namespace?.source === "react" &&
      (namespace.imported === "default" || namespace.imported === "*") &&
      this.staticMemberName(type) === "Fragment"
    );
  }

  private isJsxCall(node: Node | null | undefined): node is CallExpression {
    if (node?.type !== "CallExpression") {
      return false;
    }

    const imported = this.importOf(node.callee);

    return imported !== undefined && JSX_RUNTIMES.has(imported.source) && imported.imported !== "Fragment";
  }

  private kindOf(node: Node | null | undefined): Kind {
    return this.bindings.kindOf(node, this.scope);
  }

  private originOf(node: Node | null | undefined): Origin {
    return this.bindings.originOf(node, this.scope);
  }

  // A translator cannot be passed, so a value derived from an npm import never holds one, though it may hold an
  // IntlInstance (whose `.t` calls are checked on their own).
  private cannotHoldT(node: Node | null | undefined): boolean {
    const origin = this.originOf(node);

    return origin === "unrelated" || origin === "derived";
  }

  private staticValueIn(scope: Scope): StaticValueOf {
    return this.bindings.staticValueIn(scope);
  }

  private memberName(node: Node & { readonly type: "MemberExpression" }): StaticName {
    return this.bindings.memberName(node, this.scope);
  }

  private staticMemberName(node: Node | undefined): string | undefined {
    if (node?.type !== "MemberExpression") {
      return undefined;
    }

    const name = this.memberName(node);

    return name._tag === "Static" ? name.name : undefined;
  }

  // The nearest ancestor of the visited node that is not one of `transparent`, and its child on the way down.
  private useOf(transparent: ReadonlySet<string>): Use {
    return this.useAt(this.ancestors.length - 1, transparent);
  }

  // The same for the ancestor at `index` (the visited node is the last).
  private useAt(index: number, transparent: ReadonlySet<string>): Use {
    for (let i = index - 1; i >= 0; i -= 1) {
      const ancestor = this.ancestors[i];

      if (ancestor && !transparent.has(ancestor.type)) {
        return { parent: ancestor, child: this.ancestors[i + 1] };
      }
    }

    return { parent: undefined, child: undefined };
  }

  private visit(node: Node, parent: Node | undefined): void {
    if (node.type === "ImportDeclaration") {
      return;
    }

    this.ancestors.push(node);
    const outer = this.scope;
    this.scope = this.tree.scopeOf(node) ?? outer;

    if (node.type === "Identifier" && parent && isReference(node, parent)) {
      this.checkIdentifier(node.name, node, parent);
    }

    if (this.importsPackage && node.type === "MemberExpression") {
      this.checkMember(node);
    }

    this.checkNode(node);
    for (const child of childNodes(node)) {
      if (node.type === "VariableDeclarator" && child === node.id) {
        this.visitPattern(node.id);
      } else {
        this.visit(child, node);
      }
    }

    this.scope = outer;
    this.ancestors.pop();
  }

  // A declaration pattern binds names, which are not uses; its defaults and computed keys are ordinary code.
  private visitPattern(pattern: Node): void {
    this.ancestors.push(pattern);
    switch (pattern.type) {
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            this.visitPattern(property.argument);
          } else {
            if (property.computed) {
              this.visit(property.key, property);
            }

            this.visitPattern(property.value);
          }
        }
        break;
      case "ArrayPattern":
        for (const element of pattern.elements) {
          if (element) {
            this.visitPattern(element);
          }
        }
        break;
      case "AssignmentPattern":
        this.visit(pattern.right, pattern);
        this.visitPattern(pattern.left);
        break;
      case "RestElement":
        this.visitPattern(pattern.argument);
        break;
      default:
        break;
    }

    this.ancestors.pop();
  }

  // `CurrentIntl` is read only as `yield* CurrentIntl` and provided only by calling `.layer(…)` or `.provide(…)`: any
  // other read (`.use`, `Effect.map(CurrentIntl, …)`, an alias) reaches the translator where extraction cannot see it.
  private checkService(name: string, node: Node): void {
    const { parent, child } = this.useOf(VALUE_TRANSPARENT);
    const yielded = parent?.type === "YieldExpression" && parent.delegate && parent.argument === child;
    const member =
      parent?.type === "MemberExpression" && parent.object === child
        ? this.staticMemberName(parent)
        : undefined;
    const call =
      member === "layer" || member === "provide"
        ? this.useAt(this.ancestors.lastIndexOf(parent ?? node), VALUE_TRANSPARENT)
        : undefined;
    const provided = call?.parent?.type === "CallExpression" && call.parent.callee === call.child;

    if (!yielded && !provided) {
      this.fail(
        node,
        `\`${name}\` is only read with \`yield* ${name}\` and provided with \`.layer(…)\` or \`.provide(…)\`, so extraction sees every translator; read the translator with \`const { t } = yield* CurrentIntl\``
      );
    }
  }

  // A package binding or a bound t may only be called, aliased or (for t) used as t.from; IntlInstance objects may flow.
  private checkIdentifier(name: string, node: Node, parent: Node): void {
    if (this.bindings.isService(node, this.scope)) {
      this.checkService(name, node);

      return;
    }

    const called =
      parent.type === "CallExpression" &&
      (parent.callee === node || (this.isJsxCall(parent) && parent.arguments[0] === node));
    const aliased = parent.type === "VariableDeclarator" && parent.init === node;
    const kind = this.kindOf(node);
    const member =
      parent.type === "MemberExpression" && parent.object === node
        ? this.staticMemberName(parent)
        : undefined;
    const tFrom = member === "from";
    // [t] as a hook's dependency array (exhaustive-deps requires it) is a reference, not a use.
    const grand = this.ancestors.at(-3);
    const hookDependency =
      parent.type === "ArrayExpression" &&
      grand?.type === "CallExpression" &&
      grand.callee.type === "Identifier" &&
      HOOK_NAME.test(grand.callee.name) &&
      grand.arguments.at(-1) === parent;
    const imported = this.packageImport(node);

    if (
      imported !== undefined &&
      JSX_ONLY.has(imported) &&
      parent.type === "CallExpression" &&
      parent.callee === node
    ) {
      this.fail(node, `\`${name}(…)\` hides its message from extraction; use JSX: <${name}>…</${name}>`);
    }

    if (aliased && imported !== undefined) {
      this.fail(
        node,
        `aliasing \`${name}\` from the intl package hides its call sites; use the import directly`
      );
    }

    // Reflect reads properties by a key it is passed; only a direct `Reflect.x(…)` call is checked (by checkCall).
    if (
      this.importsPackage &&
      name === "Reflect" &&
      resolveName(this.scope, name) === undefined &&
      (member === undefined || grand?.type !== "CallExpression" || grand.callee !== parent)
    ) {
      this.fail(
        node,
        "`Reflect` is passed or stored; call `Reflect.x(…)` directly so its key can be checked"
      );
    }

    if (
      !called &&
      !aliased &&
      !tFrom &&
      !(hookDependency && kind === "t") &&
      (imported !== undefined || kind === "t")
    ) {
      this.fail(node, `\`${name}\` is passed or stored; call it with a literal message where it is used`);
    }
  }

  private checkMember(node: Node & { readonly type: "MemberExpression" }): void {
    const name = this.memberName(node);

    // On an IntlInstance the extractor can see, a key it cannot name may be `t`. Receivers of unknown kind are a README
    // residual: following values instead would fail ordinary record lookups.
    if (name._tag === "Unresolved") {
      if (this.kindOf(node.object) === "intl") {
        this.fail(node, 'an unresolved computed key on an IntlInstance may read `t`; call `.t("…")` by name');
      }

      return;
    }

    const { parent, child } = this.useOf(VALUE_TRANSPARENT);

    if (name.name !== "t" || !parent || this.originOf(node.object) === "unrelated") {
      return;
    }

    const isCall = parent.type === "CallExpression" && parent.callee === child;
    const isFrom =
      parent.type === "MemberExpression" &&
      parent.object === child &&
      this.staticMemberName(parent) === "from";
    const resolvedAlias =
      parent.type === "VariableDeclarator" && parent.init === child && this.kindOf(node.object) === "intl";

    if (!isCall && !isFrom && !resolvedAlias) {
      this.fail(node, '`.t` may only be called as `.t("literal")` or `.t.from(descriptor)`');
    }
  }

  private checkNode(node: Node): void {
    if (node.type === "VariableDeclarator") {
      this.checkDeclarator(node);
    }

    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      isPackageSpecifier(stringValue(node.arguments[0]) ?? "")
    ) {
      this.fail(node, "require() of the intl package is not extractable; use a static import");
    }

    if (node.type === "ImportExpression" && isPackageSpecifier(stringValue(node.source) ?? "")) {
      this.fail(node, "dynamic import() of the intl package is not extractable; use a static import");
    }

    // These guard forms that may hide a translator; a file without the package has none to hide.
    if (this.importsPackage) {
      this.checkTPatterns(node);
    }

    if (node.type === "ExportNamedDeclaration") {
      this.checkExport(node);
    }

    if (node.type === "CallExpression") {
      this.checkCall(node);
    }
  }

  // `t` bound by a pattern that is not a declaration from a bound IntlInstance.
  private checkTPatterns(node: Node): void {
    if (node.type === "AssignmentExpression" && this.patternHasT(node.left)) {
      this.fail(
        node,
        'assigning `{ t }` by destructuring is not extractable; call `.t("…")` on an IntlInstance bound in this file'
      );
    } else if (
      (node.type === "ForOfStatement" || node.type === "ForInStatement") &&
      node.left.type !== "VariableDeclaration" &&
      this.patternHasT(node.left)
    ) {
      this.fail(
        node.left,
        'assigning `{ t }` by destructuring is not extractable; call `.t("…")` on an IntlInstance bound in this file'
      );
    } else if (node.type === "CatchClause" && node.param && this.patternHasT(node.param)) {
      this.fail(
        node.param,
        '`{ t }` destructured in a catch clause; call `.t("…")` on an IntlInstance bound in this file'
      );
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const param of node.params) {
        if (this.patternHasT(param)) {
          this.fail(
            param,
            '`{ t }` destructured in a parameter; call `.t("…")` on an IntlInstance bound in this function, or pass msg() descriptors'
          );
        }
      }
    }
  }

  private checkDeclarator(declarator: VariableDeclarator): void {
    const { id, init } = declarator;

    // A pattern over an unrelated value (`const { t } = useTranslation()`) cannot bind a package translator.
    if (!this.importsPackage || id.type === "Identifier" || this.cannotHoldT(init)) {
      return;
    }

    if (id.type === "ArrayPattern" && this.patternHasT(id)) {
      this.fail(
        id,
        '`t` destructured from an array is not extractable; call `.t("…")` on an IntlInstance bound in this file'
      );
    }

    if (id.type !== "ObjectPattern") {
      return;
    }

    // A computed key the extractor cannot read may be `t`, so it is never assumed unrelated.
    const valueOf = this.staticValueIn(this.scope);

    if (patternHasUnresolvedKey(id, valueOf)) {
      this.fail(
        id,
        "computed key in a destructuring pattern is not extractable (it may be `t`); name the key"
      );

      return;
    }

    const properties = id.properties.flatMap((property) => (property.type === "Property" ? [property] : []));
    const topT = properties.some((property) => keyName(property, valueOf) === "t");
    const nestedT = properties.some((property) => this.patternHasT(property.value));

    if ((topT && this.kindOf(init) !== "intl") || nestedT) {
      this.fail(
        id,
        '`{ t }` destructured from something that is not a bound IntlInstance; call `.t("…")` on an IntlInstance bound in this file'
      );
    }
  }

  private patternHasT(pattern: Node | null | undefined): boolean {
    return patternHasT(pattern, this.staticValueIn(this.scope));
  }

  // Exporting a bound t moves its call sites into files that cannot see where it came from.
  private checkExport(node: Node & { readonly type: "ExportNamedDeclaration" }): void {
    const message = "exporting `t` hides its call sites; call it in this module, or export msg() descriptors";
    const declarations =
      node.declaration?.type === "VariableDeclaration" ? node.declaration.declarations : [];
    for (const declarator of declarations) {
      if (
        (declarator.id.type === "Identifier" && this.kindOf(declarator.init) === "t") ||
        this.patternHasT(declarator.id)
      ) {
        this.fail(declarator, message);
      }
    }

    for (const specifier of node.specifiers) {
      if (specifier.local.type === "Identifier" && this.kindOf(specifier.local) === "t") {
        this.fail(specifier, message);
      }
    }
  }

  private checkCall(node: CallExpression): void {
    const [first, second] = node.arguments;
    const callee = unwrap(node.callee, VALUE_TRANSPARENT) ?? node.callee;

    // useT()("x") / (await getT())("x"): assign t first so the call site is plain. The advice binds the caller's own
    // expression, so a server action is never told to call a hook.
    if (
      (callee.type === "CallExpression" || callee.type === "AwaitExpression") &&
      this.kindOf(callee) === "t"
    ) {
      const translator = this.code.slice(callee.start, callee.end);
      this.fail(node, `call \`t\` through a variable: \`const t = ${translator}; t("…")\``);
    }

    // A factory result must be bound where it is created, or a wrapper hook would hide every call site.
    const factory = T_FACTORIES.find((name) => this.isPackageBinding(callee, name));

    if (factory !== undefined) {
      const { parent, child } = this.useOf(AWAIT_TRANSPARENT);
      const bound =
        (parent?.type === "VariableDeclarator" && parent.init === child) ||
        (parent?.type === "MemberExpression" &&
          parent.object === child &&
          this.staticMemberName(parent) === "from");

      if (!bound) {
        this.fail(
          node,
          `bind \`${factory}()\` to a variable where it is called (wrapping it hides messages from extraction)`
        );
      }
    }

    if (this.isJsxCall(node) && this.isPackageBinding(first, "T")) {
      extractT(this.reader(), node, second);
    }

    if (this.isPackageBinding(callee, "msg")) {
      extractMsg(this.reader(), node, first, second);

      return;
    }

    if (callee.type === "Identifier") {
      const origin = this.originOf(callee);

      if (origin === "t") {
        const source = literalValue(first);

        if (source === undefined || first === undefined) {
          this.fail(node, "t() takes a string literal; for a msg() descriptor use t.from(descriptor)");
        } else {
          this.push(source, undefined, []);
        }
      } else if (this.importsPackage && callee.name === "t" && !this.cannotHoldT(callee)) {
        // Outside an importing file a bare t cannot hold a package translator: passing or exporting one fails where it is bound.
        this.fail(
          node,
          "cannot trace `t` to useT() or getT() in this file, so `t(…)` is not extracted; bind `const t = useT()` (or `await getT()`) here"
        );
      }

      return;
    }

    if (callee.type !== "MemberExpression") {
      return;
    }

    if (this.importsPackage && this.isReflectGet(callee)) {
      const key = this.bindings.staticValue(second, this.scope);
      // A spread hides the target and key: `Reflect.get(...[i, "t"])`.
      const spread = first?.type === "SpreadElement" || second?.type === "SpreadElement";

      if (spread || key === "t" || (key === undefined && this.kindOf(first) === "intl")) {
        this.fail(node, '`Reflect.get` may read `t`; call `.t("…")` on the IntlInstance');
      }
    }

    if (this.staticMemberName(callee) !== "t") {
      return;
    }

    // In every file, importing or not: an IntlInstance may arrive as a parameter or from an app module.
    const origin = this.originOf(callee.object);

    if (origin === "unrelated") {
      return;
    }

    if (origin !== "intl") {
      const receiver = this.code.slice(callee.object.start, callee.object.end);
      this.fail(
        node,
        `cannot trace \`${receiver}\` to useIntl(), getIntl(), createIntl() or \`yield* CurrentIntl\` in this file, so \`.t(…)\` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with \`.t.from\``
      );

      return;
    }

    const source = literalValue(first);

    if (source !== undefined && first !== undefined) {
      this.push(source, undefined, []);
    } else {
      this.fail(node, ".t() takes a string literal; for a msg() descriptor use .t.from(descriptor)");
    }
  }

  private isReflectGet(callee: Node & { readonly type: "MemberExpression" }): boolean {
    return (
      callee.object.type === "Identifier" &&
      callee.object.name === "Reflect" &&
      resolveName(this.scope, "Reflect") === undefined &&
      this.staticMemberName(callee) === "get"
    );
  }

  private push(source: string, context: string | undefined, tags: ReadonlyArray<string>): void {
    this.messages.push({ key: keyOf(source, context), source, context, tags });
  }

  // Message reading at the visited node, in its scope.
  private reader(): MessageReader {
    return {
      fail: (node, message) => {
        this.fail(node, message);
      },
      push: (source, context, tags) => {
        this.push(source, context, tags);
      },
      isJsxCall: (node): node is CallExpression => this.isJsxCall(node),
      isPackageBinding: (node, name) => this.isPackageBinding(node, name),
      isFragment: (type) => this.isFragment(type),
      staticValue: this.staticValueIn(this.scope),
      code: this.code,
    };
  }
}

// Whether an identifier is read here, rather than declared or used as a property or label name.
function isReference(node: Node, parent: Node): boolean {
  switch (parent.type) {
    case "MemberExpression":
      return parent.object === node || parent.computed;
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
    case "AccessorProperty":
      return parent.key !== node || parent.computed;
    case "VariableDeclarator":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.id !== node;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    case "ExportSpecifier":
      return parent.local === node;
    default:
      return true;
  }
}

// A computed key the extractor cannot read, anywhere in a pattern.
function patternHasUnresolvedKey(pattern: Node | null | undefined, valueOf: StaticValueOf): boolean {
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.some(
      (property) =>
        property.type === "Property" &&
        (propertyKey(property, valueOf)._tag === "Unresolved" ||
          patternHasUnresolvedKey(property.value, valueOf))
    );
  }

  if (pattern?.type === "ArrayPattern") {
    return pattern.elements.some((element) => patternHasUnresolvedKey(element, valueOf));
  }

  return pattern?.type === "AssignmentPattern" ? patternHasUnresolvedKey(pattern.left, valueOf) : false;
}

// A property named t (or a computed key that may be t) anywhere in a pattern (nested objects, defaults, arrays).
function patternHasT(pattern: Node | null | undefined, valueOf: StaticValueOf): boolean {
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.some(
      (property) =>
        property.type === "Property" &&
        // An unresolved computed key may be t.
        (propertyKey(property, valueOf)._tag === "Unresolved" ||
          keyName(property, valueOf) === "t" ||
          patternHasT(property.value, valueOf))
    );
  }

  if (pattern?.type === "ArrayPattern") {
    return pattern.elements.some((element) => patternHasT(element, valueOf));
  }

  return pattern?.type === "AssignmentPattern" ? patternHasT(pattern.left, valueOf) : false;
}
