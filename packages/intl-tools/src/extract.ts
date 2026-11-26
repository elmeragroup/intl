// The deny-by-default extractor. It reads the JSX compiler's output, so entities and JSX text rules come from a real
// compiler, and resolves bindings by import source, not by name. Anything it cannot resolve is a failure that names
// the fix, never a silent skip. The CLI and the lint rule both run it, so they cannot disagree.
import type { CallExpression, Node, Program, VariableDeclarator } from "oxc-parser";
import { parseSync } from "oxc-parser";
import { transformSync } from "oxc-transform";

import type { IntlInstance } from "@elmeragroup/intl/core";
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
// The pragma that compiles a file's JSX to `factory(type, props, ...children)` (the classic runtime), read only to word a
// failure: an instance given as such a call's props (`<Row {...intl}>`) is told how to copy it. oxc reads it from a
// leading comment; a comment anywhere that names it only changes that wording, never what fails.
const CLASSIC_PRAGMA = /@jsxRuntime\s+classic\b/u;
const HOOK_NAME = /^use[A-Z]/u;
// React's hooks that take a dependency array, each with the arguments it takes when the array is given: the array is
// the last. React keeps it in hook state and never hands it back, so `[t]` or `[intl]` there goes nowhere; every other
// React hook may keep the array (`useState`, `useRef`, `useReducer`'s initial state).
const DEPENDENCY_HOOKS: ReadonlyMap<string, number> = new Map([
  ["useEffect", 2],
  ["useLayoutEffect", 2],
  ["useInsertionEffect", 2],
  ["useMemo", 2],
  ["useCallback", 2],
  ["useImperativeHandle", 3],
]);
// A translator and an IntlInstance are each bound where it is used, so extraction sees every call. A bare t is called by
// name, so a wrapper of a t-returning factory would hide it. An IntlInstance used as a value fails where it is bound
// (checkInstance), and a `.t(…)` call on one the file cannot trace to its factory fails.
const T_FACTORIES = ["useT", "getT"];

// The members an IntlInstance declares, its string keys (the `satisfies` keeps them equal to the type's, both ways): the
// only ones an instance may be read through, looked up with `Object.hasOwn`. None hands back a translator or an instance;
// the inherited `valueOf`, which `in` would find, returns the instance itself.
const INSTANCE_MEMBERS = {
  t: true,
  format: true,
  locale: true,
  timeZone: true,
  catalog: true,
  formats: true,
} as const satisfies Record<Extract<keyof IntlInstance, string>, true>;
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
  const source = parseSync(filename, code);
  const importsPackage = importsPackageIn(source.program);
  const toSource = createSourceMapper(compiled.map.mappings);
  const sourcePosition = (offset: number) =>
    toSource(positionAt(compiled.code, offset)) ?? { line: 1, column: 0 };
  const extraction = new Extraction(
    { importsPackage, classicJsx: source.comments.some((comment) => CLASSIC_PRAGMA.test(comment.value)) },
    compiled.code,
    analyzeScopes(program)
  );
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

type Use = { readonly parent: Node | undefined; readonly child: Node | undefined; readonly index: number };
// What the walk reads from the source as written, not the compiled code: whether it imports the package (type-only
// imports are erased) and whether its JSX compiles to the classic runtime's calls.
type SourceFacts = { readonly importsPackage: boolean; readonly classicJsx: boolean };
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
  private readonly classicJsx: boolean;
  private readonly code: string;
  private readonly tree: ScopeTree;

  constructor({ importsPackage, classicJsx }: SourceFacts, code: string, tree: ScopeTree) {
    this.importsPackage = importsPackage;
    this.classicJsx = classicJsx;
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

  // The export of `react` a node names: a named or renamed import, or a static member of its default or namespace
  // import (`React.useEffect`).
  private reactExport(node: Node): string | undefined {
    const imported = this.importOf(node);

    if (imported !== undefined) {
      return imported.source === "react" && imported.imported !== "default" && imported.imported !== "*"
        ? imported.imported
        : undefined;
    }

    const namespace = node.type === "MemberExpression" ? this.importOf(node.object) : undefined;

    return namespace?.source === "react" && (namespace.imported === "default" || namespace.imported === "*")
      ? this.staticMemberName(node)
      : undefined;
  }

  private isFragment(type: Node): boolean {
    const imported = this.importOf(type);

    return (
      this.reactExport(type) === "Fragment" ||
      (imported !== undefined && JSX_RUNTIMES.has(imported.source) && imported.imported === "Fragment")
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

  // A `{ t }` over an unrelated or derived value, and a bare `t(…)` bound from one, are treated as another library's
  // translator and allowed (`const { t } = useTranslation()`). A translator bound in code extraction scans reaches a
  // derived value through the custom-hook residual (`Origin` in bindings.ts says why), and fails where it is handed on
  // any other way. One from code it never reads (a package outside `include`, or one whose scope reads as npm's) may
  // arrive through any wrapper, and an instance received from there may be passed on. These are README residual rows,
  // whose `t` is not caught. A `.t(…)` on a derived value still fails as untraced (checkCall), since it
  // may be an IntlInstance.
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

  // The nearest ancestor of the visited node (or of the ancestor at `from`) that is not one of `transparent`, its child
  // on the way down, and its index among the ancestors.
  private useOf(transparent: ReadonlySet<string>, from = this.ancestors.length - 1): Use {
    for (let i = from - 1; i >= 0; i -= 1) {
      const ancestor = this.ancestors[i];

      if (ancestor && !transparent.has(ancestor.type)) {
        return { parent: ancestor, child: this.ancestors[i + 1], index: i };
      }
    }

    return { parent: undefined, child: undefined, index: -1 };
  }

  private visit(node: Node, parent: Node | undefined): void {
    if (node.type === "ImportDeclaration") {
      return;
    }

    this.ancestors.push(node);
    const outer = this.scope;
    this.scope = this.tree.scopeOf(node) ?? outer;

    if (node.type === "Identifier" && parent && isReference(node, parent, this.ancestors.at(-3))) {
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
  // `yield* CurrentIntl` is an IntlInstance expression, checked where it is used.
  private checkService(name: string, node: Node): void {
    const { parent, child, index } = this.useOf(VALUE_TRANSPARENT);
    const yielded = parent?.type === "YieldExpression" && parent.delegate && parent.argument === child;

    if (yielded && this.importsPackage) {
      this.checkInstance(parent, () => `yield* ${name}`, index);
    }

    const member =
      parent?.type === "MemberExpression" && parent.object === child
        ? this.staticMemberName(parent)
        : undefined;
    const call =
      member === "layer" || member === "provide" ? this.useOf(VALUE_TRANSPARENT, index) : undefined;
    const provided = call?.parent?.type === "CallExpression" && call.parent.callee === call.child;

    if (!yielded && !provided) {
      this.fail(
        node,
        `\`${name}\` is only read with \`yield* ${name}\` and provided with \`.layer(…)\` or \`.provide(…)\`, so extraction sees every translator; read the translator with \`const { t } = yield* CurrentIntl\``
      );
    }
  }

  // A package binding or a bound t may only be called, aliased or (for t) used as t.from or in a dependency array. An
  // exported t is checkExport's, and an IntlInstance checkInstance's.
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
    const grand = this.ancestors.at(-3);
    const hookDependency = this.isDependencyArray(parent, grand);
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
      !((hookDependency || parent.type === "ExportSpecifier") && kind === "t") &&
      (imported !== undefined || kind === "t")
    ) {
      this.fail(node, `\`${name}\` is passed or stored; call it with a literal message where it is used`);
    }

    if (kind === "intl" && this.importsPackage) {
      this.checkInstance(node, () => name);
    }
  }

  // An IntlInstance stays in the file that binds it, as `t` does: the file it reaches (a child given it as a prop, a
  // context's reader, a helper) may read `t` off it where extraction cannot see, and one that does not import the package
  // is not checked at all. So it may only be read through its own members, bound by an unexported declaration, listed
  // in a dependency array, spread into an object, given as the props of a createElement bound to a `react` import,
  // discarded or made `void`; any other use fails here, once per site. The paths that already classify an expression call it: an
  // identifier (checkIdentifier), a factory call (checkCall) and `yield* CurrentIntl` (checkService), the expression at
  // ancestor `at`. A failure names the expression by `form`, as written, never by a slice of the compiled code, which a
  // multi-line `createIntl({ … })` would garble.
  private checkInstance(node: Node, form: () => string, at = this.ancestors.length - 1): void {
    const { parent, child, index } = this.useOf(AWAIT_TRANSPARENT, at);

    if (this.isInstanceUse(node, parent, child, index)) {
      return;
    }

    // In a classic-runtime file, the props slot of any other factory is where `<Row {...intl}>` puts the instance.
    this.fail(
      node,
      this.classicJsx && parent?.type === "CallExpression" && isPropsSlot(parent, child)
        ? instanceAsClassicProps(form())
        : instanceUsedAsValue(form())
    );
  }

  // The uses an IntlInstance may have, seen through parentheses, optional chains and `await`.
  private isInstanceUse(
    node: Node,
    parent: Node | undefined,
    child: Node | undefined,
    index: number
  ): boolean {
    switch (parent?.type) {
      // A member it declares, by name; a key the extractor cannot name is checkMember's.
      case "MemberExpression": {
        const name = this.memberName(parent);

        return (
          parent.object === child &&
          (name._tag === "Unresolved" || Object.hasOwn(INSTANCE_MEMBERS, name.name))
        );
      }
      // Called, it is no instance to the code it reaches (`const t = useIntl(); t()` fails as an untraced t). As the
      // props of a createElement bound to a `react` import (`<Row {...intl}>` under the classic JSX runtime with
      // `React` imported), it is copied as a spread is: own enumerable keys only. Any other factory may keep the object
      // itself as the props, as the automatic runtime's `jsx(Row, intl)` does, so it fails, as any other argument does:
      // under the classic runtime that is `<Row {...intl}>` with `React` a global or a `@jsx` factory.
      case "CallExpression":
        return (
          parent.callee === child ||
          (isPropsSlot(parent, child) && this.reactExport(parent.callee) === "createElement")
        );
      // Bound, unless the binding is exported (`export const intl = createIntl(cfg)`): a pattern binds its members.
      case "VariableDeclarator":
        return (
          parent.init === child &&
          !(parent.id.type === "Identifier" && this.ancestors[index - 2]?.type === "ExportNamedDeclaration")
        );
      // The target of a plain assignment (`intl = undefined`) is written, not read; its value is the right side's,
      // checked on its own. A compound assignment (`intl ??= other`) reads it, so it fails.
      case "AssignmentExpression":
        return parent.operator === "=" && parent.left === child;
      // Discarded, it goes nowhere; a `void` operand is discarded too, and its value is `undefined`.
      case "ExpressionStatement":
        return true;
      case "UnaryExpression":
        return parent.operator === "void";
      // An object spread copies the config and the symbol keys `[FORMAT]` and `[REPORT]`, neither a translator, and never
      // the non-enumerable `t` or `format`.
      case "SpreadElement":
        return this.ancestors[index - 1]?.type === "ObjectExpression";
      // A dependency array lists bindings: an identifier element, never a factory's call (`[useIntl()]`).
      case "ArrayExpression":
        return (
          node.type === "Identifier" &&
          child === node &&
          this.isDependencyArray(parent, this.ancestors[index - 1])
        );
      default:
        return false;
    }
  }

  // Whether an array is a hook's dependency array (exhaustive-deps requires `[t]` and `[intl]` there), by how the hook is
  // bound. One bound to a `react` import is one of React's dependency hooks, given the array as its last argument at its
  // dependency slot. A bare `use*` callee bound to anything else (a custom effect hook) is given two or more arguments,
  // the array last; it may keep the array (README, residuals). A member of anything but React (`Hooks.useEffect`) is not.
  private isDependencyArray(array: Node, call: Node | undefined): boolean {
    if (
      array.type !== "ArrayExpression" ||
      call?.type !== "CallExpression" ||
      call.arguments.at(-1) !== array
    ) {
      return false;
    }

    const react = this.reactExport(call.callee);

    if (react !== undefined) {
      return DEPENDENCY_HOOKS.get(react) === call.arguments.length;
    }

    return (
      call.callee.type === "Identifier" && HOOK_NAME.test(call.callee.name) && call.arguments.length >= 2
    );
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
      if (
        specifier.local.type === "Identifier" &&
        isReference(specifier.local, specifier, node) &&
        this.kindOf(specifier.local) === "t"
      ) {
        this.fail(specifier, message);
      }
    }
  }

  private checkCall(node: CallExpression): void {
    const [first, second] = node.arguments;
    const callee = unwrap(node.callee, VALUE_TRANSPARENT) ?? node.callee;
    const imported = this.packageImport(callee);

    // Only a package import's call can be an IntlInstance factory's (`useIntl()`, `createIntl(cfg)`).
    if (
      this.importsPackage &&
      imported !== undefined &&
      node.callee.type === "Identifier" &&
      this.kindOf(node) === "intl"
    ) {
      const { name } = node.callee;
      this.checkInstance(node, () => `${name}(${node.arguments.length > 0 ? "…" : ""})`);
    }

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
    const factory = T_FACTORIES.find((name) => name === imported);

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

    if (imported === "msg") {
      extractMsg(this.reader(), node, first, second);

      return;
    }

    if (callee.type === "Identifier") {
      if (this.kindOf(callee) === "t") {
        const source = literalValue(first);

        if (source === undefined || first === undefined) {
          this.fail(node, "t() takes a string literal; for a msg() descriptor use t.from(descriptor)");
        } else {
          this.push(source, undefined, []);
        }
      } else if (callee.name === "t") {
        // In every file, a t rooted in an app import may be the package's translator, returned by a wrapper the
        // extractor never reads (#30). In an importing file, any t that may hold one fails.
        const appImport = this.bindings.appImportOf(callee, this.scope);

        if (appImport !== undefined || (this.importsPackage && !this.cannotHoldT(callee))) {
          this.fail(node, untracedT(appImport, this.importsPackage));
        }
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

// Why a bare `t(…)` is not extracted. The migration advice depends on the file: excluding or renaming in a file that
// imports the package would lose its intl checks, so that file is pointed at the README's adapter and split remedies.
function untracedT(appImport: string | undefined, importsPackage: boolean): string {
  const from = appImport === undefined ? "" : `; it comes from \`${appImport}\``;
  const base = `cannot trace \`t\` to useT() or getT(), or to the \`.t\` of an IntlInstance from useIntl(), getIntl(), createIntl() or \`yield* CurrentIntl\`, in this file${from}, so \`t(…)\` is not extracted; bind it here (\`const t = useT()\`, \`const t = await getT()\`, or an instance's \`const { t } = await getIntl()\`), or translate \`msg()\` descriptors with \`t.from(descriptor)\` / \`.t.from\``;

  if (!importsPackage) {
    return `${base}. If this \`t\` is another library's translator (an app module wrapping it while the app migrates), rename it in this file, or, if this file's only i18n is this legacy translator, list this file in \`exclude\` and turn \`elmera-intl/extractable\` off for it (see the README's migration section)`;
  }

  return appImport === undefined
    ? base
    : `${base}. If this \`t\` is another library's translator, have its module expose it under another name, or move the code that uses it to a file without the intl package and give that file a legacy-only remedy too (see the README's migration section)`;
}

// Why an IntlInstance used as a value is not extractable, and where to bind one instead.
function instanceUsedAsValue(form: string): string {
  return `\`${form}\` is an IntlInstance (or a promise of one) used as a value, not through its own members, so wherever it goes its \`t\` is not extracted; bind one where it is used (\`useT()\` or \`useIntl()\` in the child, \`await getIntl()\`, \`yield* CurrentIntl\` provided by \`CurrentIntl.layer(options)\` or \`CurrentIntl.provide(effect)\`, or \`createIntl(config)\` with the config passed), or pass \`msg()\` descriptors, its \`format\` or its \`locale\``;
}

// Whether a node is a call's second argument, the props of `createElement(type, props, ...children)`. A spread before it
// (`createElement(...[Row, null], intl)`) moves the slot to an index the extractor cannot know.
function isPropsSlot(call: CallExpression, node: Node | undefined): boolean {
  return call.arguments[1] === node && call.arguments[0]?.type !== "SpreadElement";
}

// Why an IntlInstance given as the props of a classic-runtime factory other than React's `createElement` is not
// extractable, and the two rewrites.
function instanceAsClassicProps(form: string): string {
  return `\`${form}\` is an IntlInstance given as the second argument of a call the extractor cannot bind to React's \`createElement\`, where a classic JSX factory takes its props: under \`@jsxRuntime classic\`, \`<Row {...${form}}>\` compiles to \`React.createElement(Row, ${form})\` with \`React\` a global, or to the \`@jsx\` pragma's factory, which may keep the instance itself as the props, so its \`t\` reaches the child unextracted; copy it yourself, \`<Row {...{ ...${form} }}>\` (\`{ ...${form} }\` in a hand-written call), or use the automatic JSX runtime (or, with \`React\` as the factory, \`import React from "react"\`)`;
}

// Whether an identifier is read here, rather than declared or used as a property or label name. `grand` is the parent's
// parent: an export specifier under `export … from "…"` names the other module's binding, not a local one.
function isReference(node: Node, parent: Node, grand: Node | undefined): boolean {
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
      return parent.local === node && !(grand?.type === "ExportNamedDeclaration" && grand.source !== null);
    // `export * as name from "…"` names an export of this module, not a local binding.
    case "ExportAllDeclaration":
      return false;
    // `import.meta` and `new.target` are syntax, not a binding named `meta` or `target`.
    case "MetaProperty":
      return false;
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
