// Small AST queries the rules share. oxc's ESTree gives every literal one `type` ("Literal"), so `typeof value` is how a
// string literal is told apart, and the generic walk reads fields `visitorKeys` would name: both live here.
import type { ESTree, Scope, Variable } from "@oxlint/plugins";

/**
 * The node as a string literal.
 *
 * @param node - Any node, or none.
 * @returns The node when it is a string literal, otherwise `undefined`.
 */
export function stringLiteral(node: ESTree.Node | null | undefined): ESTree.StringLiteral | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node : undefined;
}

/**
 * Every identifier a binding pattern declares: `a`, `{ a, b: [c] }`, `...rest`, `d = 1`.
 *
 * @param pattern - A declarator's id, a parameter or a catch parameter.
 * @returns The identifiers it binds, in source order.
 */
export function boundIdentifiers(pattern: ESTree.Node | null): ReadonlyArray<ESTree.BindingIdentifier> {
  if (pattern === null) {
    return [];
  }

  switch (pattern.type) {
    case "Identifier":
      return pattern.name === "this" ? [] : [pattern];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        property.type === "RestElement"
          ? boundIdentifiers(property.argument)
          : boundIdentifiers(property.value)
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => boundIdentifiers(element));
    case "RestElement":
      return boundIdentifiers(pattern.argument);
    case "AssignmentPattern":
      return boundIdentifiers(pattern.left);
    case "TSParameterProperty":
      return boundIdentifiers(pattern.parameter);
    default:
      return [];
  }
}

/**
 * The name an export specifier or module export name spells.
 *
 * @param name - The exported or local side of a specifier.
 * @returns Its name: an identifier's, or a string literal's value.
 */
export function moduleExportName(name: ESTree.ModuleExportName): string {
  return name.type === "Literal" ? name.value : name.name;
}

/**
 * Strips the wrappers that do not change a value: parentheses and TypeScript's `as`, `satisfies`, `!` and `<T>`.
 *
 * @param expression - Any expression.
 * @returns The expression inside every such wrapper.
 */
export function unwrap(expression: ESTree.Expression): ESTree.Expression {
  switch (expression.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
      return unwrap(expression.expression);
    default:
      return expression;
  }
}

/**
 * The dotted name of a callee or constructor: `Symbol`, `Intl.PluralRules`, `import.meta.hot.on`.
 *
 * @param expression - A callee.
 * @returns The dotted path, or `undefined` when a segment is computed or not a plain name.
 */
export function dottedName(expression: ESTree.Expression | ESTree.Super): string | undefined {
  if (expression.type === "Identifier") {
    return expression.name;
  }

  if (expression.type === "MetaProperty") {
    return `${expression.meta.name}.${expression.property.name}`;
  }

  if (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
  ) {
    const object = dottedName(expression.object);

    return object === undefined ? undefined : `${object}.${expression.property.name}`;
  }

  return undefined;
}

function isNode(value: unknown): value is ESTree.Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function children(node: ESTree.Node): ReadonlyArray<ESTree.Node> {
  return Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
    if (key === "parent") {
      return [];
    }

    if (Array.isArray(value)) {
      return value.filter((item: unknown) => isNode(item));
    }

    return isNode(value) ? [value] : [];
  });
}

function isFunctionNode(node: ESTree.Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/**
 * Whether `root` or any node inside it, not crossing into nested functions, satisfies `predicate`. `root` itself
 * counts: a concise arrow's body is the expression it returns (`() => useIntl()`).
 *
 * @param root - The node to search, such as a function body.
 * @param predicate - The test.
 * @returns `true` when `root` or a node of the same function below it satisfies it.
 */
export function containsInFunction(root: ESTree.Node, predicate: (node: ESTree.Node) => boolean): boolean {
  return (
    predicate(root) ||
    children(root).some((child) => !isFunctionNode(child) && containsInFunction(child, predicate))
  );
}

/**
 * The variable a name resolves to from a scope, walking outward.
 *
 * @param scope - The scope the name is used in (`sourceCode.getScope(node)`).
 * @param name - The name.
 * @returns The variable, or `undefined` for a name no scope declares.
 */
export function resolveVariable(scope: Scope | null, name: string): Variable | undefined {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);

    if (variable !== undefined) {
      return variable;
    }
  }

  return undefined;
}

/**
 * The import a name resolves to from a scope.
 *
 * @param scope - The scope the name is used in (`sourceCode.getScope(node)`).
 * @param name - The name.
 * @returns The imported module and the specifier that binds the name, or `undefined` when no import binds it (a local
 *   binding of the same name included).
 */
export function importOf(
  scope: Scope | null,
  name: string
): { readonly source: string; readonly specifier: ESTree.Node } | undefined {
  const definition = resolveVariable(scope, name)?.defs[0];

  return definition?.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration"
    ? { source: definition.parent.source.value, specifier: definition.node }
    : undefined;
}

/**
 * Whether a name in this scope is the platform's global: no import, declaration or parameter binds it.
 *
 * @param scope - The scope the name is used in.
 * @param name - The name, such as `Map` or `Intl`.
 * @returns `true` when only the global (or nothing) answers to the name.
 */
export function isGlobalName(scope: Scope | null, name: string): boolean {
  return (resolveVariable(scope, name)?.defs.length ?? 0) === 0;
}
