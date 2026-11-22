// A variable holding the instance is `intl`, one holding the formatter is `format`, and one holding the translator is
// `t`: the names the API's own fields and hooks use, so a call site reads the same in every file. A scope holding
// several (a test comparing locales) names each with the role as its suffix, such as nbIntl or osloFormat. A factory
// is the runtime's only when its binding resolves to an import from `@elmeragroup/intl/*` (an alias or a namespace
// member counts; a local or shadowing function of the same name does not), as the extractor traces it. On Effect,
// `yield* CurrentIntl` (the service imported from `@elmeragroup/intl/effect`) holds an instance too.
import type { ESTree, Rule } from "@oxlint/plugins";

import { importOf, moduleExportName, resolveVariable, unwrap } from "../ast.ts";
import { packageOf, pathInPackage, RUNTIME } from "../workspace.ts";

type Role = "intl" | "format" | "t";

const ROLE_BY_FACTORY: ReadonlyMap<string, Role> = new Map<string, Role>([
  ["createIntl", "intl"],
  ["useIntl", "intl"],
  ["getIntl", "intl"],
  ["useFormat", "format"],
  ["getFormat", "format"],
  ["createFormat", "format"],
  ["useT", "t"],
  ["getT", "t"],
]);

const SUFFIX = {
  intl: /^(intl|[a-z][A-Za-z0-9]*Intl)$/u,
  format: /^(format|[a-z][A-Za-z0-9]*Format)$/u,
  t: /^(t|[a-z][A-Za-z0-9]*T)$/u,
} as const satisfies Readonly<Record<Role, RegExp>>;

type Found = { readonly role: Role; readonly source: string };

// The Effect service whose `yield*` reads the instance, and the subpath it comes from.
const SERVICE = "CurrentIntl";
const SERVICE_SOURCE = `${RUNTIME}/effect`;

// Whether an import's source is the runtime: a `@elmeragroup/intl` subpath, or, inside the runtime's own source, a
// relative module.
function isRuntimeSource(source: string, runtimeSource: boolean): boolean {
  return source === RUNTIME || source.startsWith(`${RUNTIME}/`) || (runtimeSource && source.startsWith("."));
}

/** Reports a variable bound to an instance, a formatter or a translate function under another name. */
export const instanceNames: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Name a variable holding an IntlInstance `intl`, a formatter `format`, a translator `t`.",
    },
    messages: {
      rename:
        "`{{name}}` holds {{source}}: name it `{{role}}` (or `<qualifier>{{suffix}}`, such as `nb{{suffix}}`, when the scope holds several), as the API names it.",
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);
    const runtimeSource = pkg?.name === RUNTIME && pathInPackage(pkg, context.filename).startsWith("src/");
    const { sourceCode } = context;

    // The runtime factory a callee names: an import of it (aliased or not), or a member of a namespace import.
    function factoryOf(callee: ESTree.Expression): string | undefined {
      const named = callee.type === "Identifier" ? callee : undefined;
      const member =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.object.type === "Identifier"
          ? { namespace: callee.object, name: callee.property.name }
          : undefined;
      const identifier = named ?? member?.namespace;
      const imported =
        identifier === undefined ? undefined : importOf(sourceCode.getScope(identifier), identifier.name);

      if (imported === undefined || !isRuntimeSource(imported.source, runtimeSource)) {
        return undefined;
      }

      if (member !== undefined) {
        return imported.specifier.type === "ImportNamespaceSpecifier" ? member.name : undefined;
      }

      return imported.specifier.type === "ImportSpecifier"
        ? moduleExportName(imported.specifier.imported)
        : undefined;
    }

    // Whether an expression is the runtime's Effect service: its import (aliased or not), or, inside the runtime's own
    // source, the import of a relative module. A namespace member (`yield* intlNs.CurrentIntl`) is not: the extractor
    // rejects a namespace import of the runtime and does not trace it, and elmera-intl/extractable reports it.
    function isService(expression: ESTree.Expression): boolean {
      const value = unwrap(expression);

      if (value.type !== "Identifier") {
        return false;
      }

      const imported = importOf(sourceCode.getScope(value), value.name);

      return (
        imported !== undefined &&
        (imported.source === SERVICE_SOURCE || (runtimeSource && imported.source.startsWith("."))) &&
        imported.specifier.type === "ImportSpecifier" &&
        moduleExportName(imported.specifier.imported) === SERVICE
      );
    }

    // The role a runtime factory's call (awaited or not) gives the value it returns, or `yield* CurrentIntl` its read.
    function factoryRole(init: ESTree.Expression): Found | undefined {
      const value = unwrap(init);

      if (value.type === "YieldExpression") {
        return value.delegate && value.argument !== null && isService(value.argument)
          ? { role: "intl", source: `yield* ${SERVICE}` }
          : undefined;
      }
      const called = value.type === "AwaitExpression" ? unwrap(value.argument) : value;

      if (called.type !== "CallExpression" || called.callee.type === "Super") {
        return undefined;
      }

      const factory = factoryOf(unwrap(called.callee));
      const role = factory === undefined ? undefined : ROLE_BY_FACTORY.get(factory);

      return role === undefined || factory === undefined ? undefined : { role, source: `${factory}()` };
    }

    // The role a declarator's initializer gives its binding: a factory's call, or the `.format` of a variable whose
    // own initializer is a factory call returning an instance. The holder is read once, never followed further, so a
    // binding read from itself or a cycle of them ends.
    function roleOf(init: ESTree.Expression): Found | undefined {
      const direct = factoryRole(init);
      const value = unwrap(init);

      if (
        direct !== undefined ||
        value.type !== "MemberExpression" ||
        value.computed ||
        value.property.type !== "Identifier" ||
        value.property.name !== "format" ||
        value.object.type !== "Identifier"
      ) {
        return direct;
      }

      const holder = resolveVariable(sourceCode.getScope(value), value.object.name)?.defs[0];
      const holds =
        holder?.type === "Variable" &&
        holder.node.type === "VariableDeclarator" &&
        holder.node.init !== null &&
        factoryRole(holder.node.init)?.role === "intl";

      return holds ? { role: "format", source: `${value.object.name}.format` } : undefined;
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init === null) {
          return;
        }

        const found = roleOf(node.init);

        if (found === undefined || SUFFIX[found.role].test(node.id.name)) {
          return;
        }

        context.report({
          node: node.id,
          messageId: "rename",
          data: {
            name: node.id.name,
            source: found.source,
            role: found.role,
            suffix: found.role === "t" ? "T" : `${found.role[0]?.toUpperCase() ?? ""}${found.role.slice(1)}`,
          },
        });
      },
    };
  },
};
