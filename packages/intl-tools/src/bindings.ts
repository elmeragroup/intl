// What the extractor's names and values hold: package imports, const strings, and translators (is this a translator or
// an IntlInstance?).
import type { Node } from "oxc-parser";

import { childNodes } from "./ast-children.ts";
import type { StaticName, StaticValueOf } from "./extract-message.ts";
import { propertyKey, textValue } from "./extract-message.ts";
import type { Binding, Declaration, Scope } from "./scopes.ts";
import { resolveName } from "./scopes.ts";

/** What a value holds, as far as extraction cares: a translator, an IntlInstance, or anything else. */
export type Kind = "t" | "intl" | "other";

/**
 * Where a value comes from, for a receiver of `.t(…)` or a destructured `{ t }`: a translator or IntlInstance bound from
 * the package (`t`, `intl`), provably not one (`unrelated`), read or returned from an npm import (`derived`), or anything
 * the extractor cannot follow (`untraced`). A `derived` value may hold an IntlInstance handed to it by code extraction
 * never reads, or kept from its dependency array by a `use*` hook not imported from `react` (`useStore(cb, [intl])`, a
 * README residual); one this file hands it any other way fails where it is bound. An instance or translator bound in
 * code extraction scans reaches it through that residual, and fails where it is handed on any other way; one that arrived
 * from code extraction never reads may be passed on, and that code may hand it one through any wrapper (a package
 * outside `include`, or one whose scope reads as npm's): the README's residual rows on those.
 */
export type Origin = "t" | "intl" | "unrelated" | "derived" | "untraced";

/** An import declaration of a name. */
export type Import = Extract<Declaration, { readonly _tag: "Import" }>;

/** Wrappers seen through on the way from a value to its use: parentheses and optional chains. */
export const VALUE_TRANSPARENT: ReadonlySet<string> = new Set(["ParenthesizedExpression", "ChainExpression"]);

/** `VALUE_TRANSPARENT` and `await`: awaiting a translator or an IntlInstance (or a factory's promise of one) yields it. */
export const AWAIT_TRANSPARENT: ReadonlySet<string> = new Set([...VALUE_TRANSPARENT, "AwaitExpression"]);

const PACKAGE_SPECIFIER = /^@elmeragroup\/intl(\/.*)?$/u;
// The build-time tools: a package of ours, never an app module, though its scope is the workspace's.
const TOOLS_SPECIFIER = /^@elmeragroup\/intl-tools(\/.*)?$/u;
// A package a registry scheme (in any case, as a URL's) names, with or without a version: its name, then its subpath.
const REGISTRY_SPECIFIER = /^(?:npm|jsr):((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(\/.*)?$/iu;
// An npm package, or a module a runtime or registry scheme names (`node:`, `bun:`, `deno:`, `npm:`, `jsr:`). Relative,
// aliased (`@/`, `~/`, `#`) and workspace (`@elmeragroup/`) modules may export an IntlInstance, so their imports stay
// untraced, as does any other scheme: a `file:` URL names a file of the app, a bundler's `virtual:` module is the
// app's, and an app may define its own. A drive letter (`c:/`) is no scheme at all.
const FOREIGN_SPECIFIER = /^(?:(?:node|bun|deno|npm|jsr):|(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/|$))/iu;
const WORKSPACE_SCOPE = "@elmeragroup/";
// Values written in the file that hold no other value: a primitive is data; a function or class is code, so passing one
// to a call may make the call return anything (`useMemo(make, [])`).
const DATA_VALUES = new Set(["Literal", "TemplateLiteral"]);
const CODE_VALUES = new Set(["ArrowFunctionExpression", "FunctionExpression", "ClassExpression"]);
const CONTAINER_LITERALS = new Set(["ObjectExpression", "ArrayExpression"]);
// What each package factory returns.
const FACTORY_KINDS: ReadonlyMap<string, "t" | "intl"> = new Map([
  ["useT", "t"],
  ["getT", "t"],
  ["useIntl", "intl"],
  ["getIntl", "intl"],
  ["createIntl", "intl"],
]);
// The Effect service `yield*` reads an IntlInstance from, and the subpath it is imported from.
const SERVICE = { imported: "CurrentIntl", source: "@elmeragroup/intl/effect" } as const;
// A const key resolves through at most this many const aliases.
const MAX_ALIAS_DEPTH = 16;

/**
 * Whether a specifier names the package or one of its subpaths.
 *
 * @param specifier - An import specifier.
 * @returns `true` for `@elmeragroup/intl` and `@elmeragroup/intl/*`, also when a registry scheme names them
 *   (`npm:@elmeragroup/intl@1.2.3/react`, `jsr:@elmeragroup/intl/react`).
 */
export function isPackageSpecifier(specifier: string): boolean {
  return PACKAGE_SPECIFIER.test(unqualified(specifier));
}

// The package a registry scheme names, without the scheme or a version: Deno imports the intl packages as
// `npm:@elmeragroup/intl@1.2.3/react` or `jsr:@elmeragroup/intl/react`, which are the packages themselves.
function unqualified(specifier: string): string {
  const qualified = REGISTRY_SPECIFIER.exec(specifier);

  return qualified ? `${qualified[1] ?? ""}${qualified[2] ?? ""}` : specifier;
}

// An npm package or a module a runtime or registry scheme names, outside the workspace's scope and other than the intl
// packages.
function isForeignSpecifier(specifier: string): boolean {
  return (
    FOREIGN_SPECIFIER.test(specifier) &&
    !specifier.startsWith(WORKSPACE_SCOPE) &&
    !isPackageSpecifier(specifier)
  );
}

// A module of the app: relative, aliased (`@/`, `~/`, `#`) or in the workspace's scope, other than the intl packages.
function isAppSpecifier(specifier: string): boolean {
  return !isForeignSpecifier(specifier) && !isPackageSpecifier(specifier) && !TOOLS_SPECIFIER.test(specifier);
}

// Whether a `var` of this name written in this scope sits inside a catch clause whose parameter has the name. Only a
// simple parameter can share a name with a `var` in its clause, and the scopes between a `var` and the function body or
// static block it hoists to are blocks, loops and catch clauses, so a parameter there is the catch clause's.
function assignsCatchParameter(name: string, site: Scope): boolean {
  for (let scope: Scope | undefined = site; scope !== undefined && !scope.hoistsVar; scope = scope.parent) {
    if (
      scope.bindings.get(name)?.declarations.some((declaration) => declaration._tag === "Parameter") === true
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Remove wrappers around a value: oxc keeps parentheses as nodes.
 *
 * @param node - The expression.
 * @param transparent - The wrapper node types to see through.
 * @returns The innermost wrapped node.
 */
export function unwrap(
  node: Node | null | undefined,
  transparent: ReadonlySet<string>
): Node | null | undefined {
  if (!node || !transparent.has(node.type)) {
    return node;
  }

  switch (node.type) {
    case "ParenthesizedExpression":
    case "ChainExpression":
      return unwrap(node.expression, transparent);
    case "AwaitExpression":
      return unwrap(node.argument, transparent);
    default:
      return node;
  }
}

/**
 * A pattern property's key, when it is static.
 *
 * @param property - The pattern or object property.
 * @param valueOf - Resolves a computed key.
 * @returns The key, or `undefined` when it cannot be read.
 */
export function keyName(
  property: Node & { readonly type: "Property" },
  valueOf: StaticValueOf
): string | undefined {
  const key = propertyKey(property, valueOf);

  return key._tag === "Static" ? key.name : undefined;
}

/** The bindings of one module, resolved lazily and memoized. */
export class Bindings {
  private readonly kinds = new Map<Binding, Kind>();

  /**
   * What a value holds.
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns Its kind.
   */
  kindOf(node: Node | null | undefined, scope: Scope): Kind {
    const value = unwrap(node, AWAIT_TRANSPARENT);

    if (value?.type === "Identifier") {
      return this.kindOfBinding(resolveName(scope, value.name));
    }

    // Aliases of a bound IntlInstance's t: `intl.t`, `intl["t"]`, `createIntl(cfg).t` and `(await getIntl()).t`.
    if (value?.type === "MemberExpression") {
      const name = this.memberName(value, scope);

      return name._tag === "Static" && name.name === "t" && this.kindOf(value.object, scope) === "intl"
        ? "t"
        : "other";
    }

    // `yield* CurrentIntl` reads the IntlInstance the Effect service holds.
    if (value?.type === "YieldExpression") {
      return value.delegate && this.isService(unwrap(value.argument, VALUE_TRANSPARENT), scope)
        ? "intl"
        : "other";
    }

    if (value?.type !== "CallExpression") {
      return "other";
    }

    const imported = this.importOf(value.callee, scope);

    return (
      (imported && isPackageSpecifier(imported.source) ? FACTORY_KINDS.get(imported.imported) : undefined) ??
      "other"
    );
  }

  /**
   * Where a value comes from, through `await` and `const` initializers. Unrelated means proven unrelated: a value written
   * in this file (a function or class, a primitive, or an object or array literal without getters holding only unrelated
   * values), or an npm package's import itself. Derived: an npm import read through members, destructured without
   * defaults, or called with only inline data arguments (primitives, and object or array literals of them). Anything
   * else is untraced: a local function's result, a call given a function or a named container (`useMemo(make, [])`), a
   * reassignable variable, a binding with a default, and a member or projection of a local object
   * (`box.i = createIntl(cfg)`).
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns Its origin.
   */
  originOf(node: Node | null | undefined, scope: Scope): Origin {
    const kind = this.kindOf(node, scope);

    if (kind !== "other") {
      return kind;
    }

    const root = this.rootOf(node, scope, 0);

    return root === "untraced" || root === "derived" ? root : "unrelated";
  }

  /**
   * The first app import a value is rooted in: one the classifier does not call foreign (a relative, `@/`, `~/`, `#` or
   * `@elmeragroup/*` module other than the intl packages), reached through `await`, `yield*`, the initializer of any
   * `const`, `let` or `var` declaration of a name (destructured or not), a plain assignment's right-hand side, a member's
   * object, and a call's or `new`'s callee, never its arguments: `useContext(LocalCtx)` is rooted in `react`. A translator rooted there may be the
   * package's, returned by a wrapper the extractor never reads, so a bare `t(…)` on it fails in every file (#30).
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns The import's specifier, or `undefined` when no app import is reached in fewer than `MAX_ALIAS_DEPTH` steps.
   */
  appImportOf(node: Node | null | undefined, scope: Scope): string | undefined {
    return this.appImportAt(node, scope, 0, new Map());
  }

  /**
   * The import an identifier refers to.
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns The import, or `undefined` for anything else.
   */
  importOf(node: Node | null | undefined, scope: Scope): Import | undefined {
    if (node?.type !== "Identifier") {
      return undefined;
    }

    const declaration = resolveName(scope, node.name)?.declarations[0];

    return declaration?._tag === "Import" ? declaration : undefined;
  }

  /**
   * Whether an identifier is the Effect service `CurrentIntl`: its import from `@elmeragroup/intl/effect`, renamed or
   * not. A local binding that shadows it is not.
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns `true` for the service's import.
   */
  isService(node: Node | null | undefined, scope: Scope): boolean {
    const imported = this.importOf(node, scope);

    return (
      imported !== undefined &&
      unqualified(imported.source) === SERVICE.source &&
      imported.imported === SERVICE.imported
    );
  }

  /**
   * A literal string or number, an expression-free template, or a const bound (through const aliases) to one.
   *
   * @param node - The expression.
   * @param scope - The scope it is evaluated in.
   * @returns The string, or `undefined` when it is not static.
   */
  staticValue(node: Node | null | undefined, scope: Scope): string | undefined {
    return this.staticValueAt(node, scope, 0);
  }

  /**
   * `staticValue` bound to one scope.
   *
   * @param scope - The scope values are evaluated in.
   * @returns The resolver.
   */
  staticValueIn(scope: Scope): StaticValueOf {
    return (node) => this.staticValue(node, scope);
  }

  /**
   * A member expression's property name: its identifier, or a computed key's static value.
   *
   * @param node - The member expression.
   * @param scope - The scope it is evaluated in.
   * @returns The name, or `Unresolved` for a computed key that is not static.
   */
  memberName(node: Node & { readonly type: "MemberExpression" }, scope: Scope): StaticName {
    if (!node.computed) {
      return {
        _tag: "Static",
        name: node.property.type === "Identifier" ? node.property.name : `#${node.property.name}`,
      };
    }

    const name = this.staticValue(node.property, scope);

    return name === undefined ? { _tag: "Unresolved" } : { _tag: "Static", name };
  }

  private rootOf(node: Node | null | undefined, scope: Scope, depth: number): Root {
    const value = unwrap(node, AWAIT_TRANSPARENT);

    if (!value || depth >= MAX_ALIAS_DEPTH) {
      return "untraced";
    }

    if (DATA_VALUES.has(value.type)) {
      return "data";
    }

    if (CODE_VALUES.has(value.type)) {
      return "local";
    }

    switch (value.type) {
      case "Identifier": {
        const roots = (resolveName(scope, value.name)?.declarations ?? []).map((declaration) =>
          this.rootOfDeclaration(declaration, depth)
        );
        const [first] = roots;

        return first !== undefined && roots.every((root) => root === first) ? first : "untraced";
      }
      case "ObjectExpression":
        // A getter hides what a read returns.
        return value.properties.some((property) => property.type === "Property" && property.kind !== "init")
          ? "untraced"
          : this.literalRoot(
              value.properties.map((property) =>
                property.type === "Property" ? property.value : property.argument
              ),
              scope,
              depth
            );
      case "ArrayExpression":
        return this.literalRoot(
          value.elements.flatMap((element) =>
            element === null ? [] : [element.type === "SpreadElement" ? element.argument : element]
          ),
          scope,
          depth
        );
      case "MemberExpression":
        return isNpm(this.rootOf(value.object, scope, depth + 1)) ? "derived" : "untraced";
      // Code or a container passed in may come back holding an IntlInstance (`useMemo(make, [])`, `identity(box)`).
      case "CallExpression":
      case "NewExpression":
        return isNpm(this.rootOf(value.callee, scope, depth + 1)) &&
          value.arguments.every(
            (argument) =>
              this.rootOf(
                argument.type === "SpreadElement" ? argument.argument : argument,
                scope,
                depth + 1
              ) === "data"
          )
          ? "derived"
          : "untraced";
      default:
        return "untraced";
    }
  }

  // `visited` holds the shallowest depth each binding's declarations were walked at in this lookup. One reached again at
  // that depth or deeper is skipped, so `var t = t` ends and a name redeclared many times is walked once per depth, not
  // once per declaration; one reached shallower is walked again, because the deeper walk may have spent its depth budget
  // before reaching the import (`var t = a12(); var t = mid();`).
  private appImportAt(
    node: Node | null | undefined,
    scope: Scope,
    depth: number,
    visited: Map<Binding, number>
  ): string | undefined {
    const value = unwrap(node, AWAIT_TRANSPARENT);

    if (!value || depth >= MAX_ALIAS_DEPTH) {
      return undefined;
    }

    switch (value.type) {
      case "Identifier": {
        const binding = resolveName(scope, value.name);
        const walked = binding === undefined ? undefined : visited.get(binding);

        if (binding === undefined || (walked !== undefined && walked <= depth)) {
          return undefined;
        }

        visited.set(binding, depth);

        for (const declaration of binding.declarations) {
          const found = this.appImportOfDeclaration(value.name, declaration, depth, visited);

          if (found !== undefined) {
            return found;
          }
        }

        return undefined;
      }
      // A plain `yield` receives its value from whoever resumes the generator.
      case "YieldExpression":
        return value.delegate ? this.appImportAt(value.argument, scope, depth + 1, visited) : undefined;
      case "MemberExpression":
        return this.appImportAt(value.object, scope, depth + 1, visited);
      case "CallExpression":
      case "NewExpression":
        return this.appImportAt(value.callee, scope, depth + 1, visited);
      // An assignment's value is its right-hand side: a TypeScript namespace's export compiles to one
      // (`const t = _Labels.t = getT()`). A compound assignment computes a new value.
      case "AssignmentExpression":
        return value.operator === "=" ? this.appImportAt(value.right, scope, depth + 1, visited) : undefined;
      default:
        return undefined;
    }
  }

  // A `var` written inside `catch (name)` assigns the catch parameter, not the hoisted name, so its initializer never
  // reaches a read of the name outside the clause.
  private appImportOfDeclaration(
    name: string,
    declaration: Declaration,
    depth: number,
    visited: Map<Binding, number>
  ): string | undefined {
    switch (declaration._tag) {
      case "Import":
        return isAppSpecifier(declaration.source) ? declaration.source : undefined;
      case "Variable":
        return assignsCatchParameter(name, declaration.site)
          ? undefined
          : this.appImportAt(declaration.declarator.init, declaration.site, depth + 1, visited);
      case "Local":
      case "Parameter":
        return undefined;
    }
  }

  // A literal holding these values: data when every one is, untraced when any is (`{ a: intl }` carries an
  // IntlInstance), else local.
  private literalRoot(values: ReadonlyArray<Node>, scope: Scope, depth: number): Root {
    const roots = values.map((value) => this.rootOf(value, scope, depth + 1));

    if (roots.includes("untraced")) {
      return "untraced";
    }

    return roots.every((root) => root === "data") ? "data" : "local";
  }

  private rootOfDeclaration(declaration: Declaration, depth: number): Root {
    switch (declaration._tag) {
      case "Import":
        return isForeignSpecifier(declaration.source) ? "foreign" : "untraced";
      case "Variable":
        return declaration.constant ? this.rootOfVariable(declaration, depth) : "untraced";
      case "Local":
        return "local";
      case "Parameter":
        return "untraced";
    }
  }

  private rootOfVariable(
    declaration: Extract<Declaration, { readonly _tag: "Variable" }>,
    depth: number
  ): Root {
    const { declarator, position, site } = declaration;
    const root = this.rootOf(declarator.init, site, depth + 1);

    // A named container may be written to (`box.i = createIntl(cfg)`), so it is no longer inert data.
    if (position._tag === "Id") {
      return root === "data" && CONTAINER_LITERALS.has(unwrap(declarator.init, AWAIT_TRANSPARENT)?.type ?? "")
        ? "local"
        : root;
    }

    // A projection is only as known as its container, and a default may hold anything.
    return isNpm(root) && !hasDefault(declarator.id) ? "derived" : "untraced";
  }

  private kindOfBinding(binding: Binding | undefined): Kind {
    if (binding === undefined) {
      return "other";
    }

    const known = this.kinds.get(binding);

    if (known) {
      return known;
    }

    // Provisional while resolving, so a self-referencing initializer ends instead of recursing.
    this.kinds.set(binding, "other");
    const kinds = new Set(binding.declarations.map((declaration) => this.kindOfDeclaration(declaration)));
    // A redeclared `var` holds any of its initializers: the strongest kind counts.
    const kind = kinds.has("t") ? "t" : kinds.has("intl") ? "intl" : "other";
    this.kinds.set(binding, kind);

    return kind;
  }

  private kindOfDeclaration(declaration: Declaration): Kind {
    if (declaration._tag !== "Variable") {
      return "other";
    }

    const { declarator, position, site } = declaration;
    switch (position._tag) {
      case "Id":
        return this.kindOf(declarator.init, site);
      case "TopLevelKey":
        return keyName(position.property, this.staticValueIn(site)) === "t" &&
          this.kindOf(declarator.init, site) === "intl"
          ? "t"
          : "other";
      case "Nested":
        return "other";
    }
  }

  private staticValueAt(node: Node | null | undefined, scope: Scope, depth: number): string | undefined {
    const value = unwrap(node, VALUE_TRANSPARENT);
    const literal = textValue(value);

    if (literal !== undefined) {
      return literal;
    }

    const declaration = constDeclaration(value, scope);

    if (!declaration || depth >= MAX_ALIAS_DEPTH) {
      return undefined;
    }

    return this.staticValueAt(declaration.declarator.init, declaration.site, depth + 1);
  }
}

// What a value is rooted in: inert data written inline in this file, another value written in this file, an npm
// package's import, a value read or returned from one, or anything else.
type Root = "data" | "local" | "foreign" | "derived" | "untraced";

function isNpm(root: Root): boolean {
  return root === "foreign" || root === "derived";
}

// Whether a pattern has a default anywhere.
function hasDefault(node: Node): boolean {
  return node.type === "AssignmentPattern" || childNodes(node).some((child) => hasDefault(child));
}

// The one `const x = …` declaration an identifier refers to.
function constDeclaration(
  node: Node | null | undefined,
  scope: Scope
): Extract<Declaration, { readonly _tag: "Variable" }> | undefined {
  if (node?.type !== "Identifier") {
    return undefined;
  }

  const declarations = resolveName(scope, node.name)?.declarations ?? [];
  const [declaration] = declarations;

  return declarations.length === 1 &&
    declaration?._tag === "Variable" &&
    declaration.constant &&
    declaration.position._tag === "Id"
    ? declaration
    : undefined;
}
