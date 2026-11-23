// A name in a namespace the whole app shares carries the `elmera-` prefix, so it cannot collide with another library's:
// the oxlint plugin name (the prefix of every rule id an app writes), a `Symbol.for` key, a dev server's custom HMR
// event, and, in the published packages' source, the string constants that name such things (`*_EVENT`, `*_FILE`,
// such as `elmera-intl.json`), and the key of an Effect `Context.Service` or `Context.Reference` declared there
// (`elmera-intl/CurrentIntl`): a host's Context holds every library's services by key, so such a key carries its own
// package's namespace (`@elmeragroup/intl` → `elmera-intl/`), written as a literal where it is declared. Imported
// names do not need it (`intl()`): the specifier already scopes them. The bin and the export conditions live in
// package.json, which the manifest test checks. Vite's own HMR events keep the names Vite gives them, since a listener
// under any other name never fires.
import type { ESTree, Rule } from "@oxlint/plugins";

import { dottedName, importOf, moduleExportName, stringLiteral, unwrap } from "../ast.ts";
import { isPublishedSource, packageOf } from "../workspace.ts";

const PREFIX = /^elmera[-.]/u;
const GLOBAL_CONSTANT = /_(EVENT|FILE)$/u;
const HOT_METHODS = new Set(["on", "off", "send"]);

/**
 * The HMR events Vite itself sends, the keys of `CustomEventMap` in `vite/types/customEvent.d.ts`; a test holds this
 * list to the installed declarations.
 */
export const VITE_EVENTS: ReadonlySet<string> = new Set([
  "vite:beforeUpdate",
  "vite:afterUpdate",
  "vite:beforePrune",
  "vite:beforeFullReload",
  "vite:error",
  "vite:invalidate",
  "vite:ws:connect",
  "vite:ws:disconnect",
  "vite:forward-console",
  "vite:client-connected",
  "vite:bundled-dev:reload-needed",
  "vite:client:connect",
  "vite:client:disconnect",
]);

// The Effect modules `Context.Service` and `Context.Reference` are read from: `import * as Context from "effect/Context"`,
// `import { Context } from "effect"`, or `import { Service } from "effect/Context"`.
const CONTEXT_MODULE = "effect/Context";
const EFFECT_ROOT = "effect";

function propertyNamed(object: ESTree.ObjectExpression, name: string): ESTree.ObjectProperty | undefined {
  return object.properties.find(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === name
  );
}

/** Reports a global-namespace name without the `elmera-` prefix. */
export const globalNames: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Names in a namespace the whole app shares carry the elmera- prefix." },
    messages: {
      prefix:
        '"{{value}}" is {{what}}, a namespace the whole app shares: prefix it `elmera-` (as `elmera-intl`, `elmera-intl.json`) so it cannot collide with another library\'s.',
      serviceKey:
        "\"{{value}}\" is an Effect service key, which every library's services share in a Context: start it with this package's namespace, `{{namespace}}/` (as `elmera-intl/CurrentIntl`), so it cannot collide with another library's or another Elmera package's.",
      literalKey:
        'Write the Effect service key as a string literal where the service is declared (`Context.Service<…>()("elmera-intl/Name")`), so its namespace can be checked.',
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);
    const shipped = pkg !== undefined && isPublishedSource(pkg, context.filename);
    // `@elmeragroup/intl` → `elmera-intl`: the namespace of this package's service keys.
    const namespace = pkg?.name?.replace(/^@elmeragroup\//u, "elmera-");

    function check(literal: ESTree.StringLiteral | undefined, what: string): void {
      if (literal !== undefined && !PREFIX.test(literal.value)) {
        context.report({ node: literal, messageId: "prefix", data: { value: literal.value, what } });
      }
    }

    // The export of effect a callee names, as a path from effect's root module: `Context.Service`, through a namespace
    // or named import of `effect` or of `effect/Context`, any depth of static members. A local binding names none.
    function effectPath(callee: ESTree.Expression): ReadonlyArray<string> | undefined {
      const members: Array<string> = [];
      let value = unwrap(callee);

      while (value.type === "MemberExpression" && !value.computed && value.property.type === "Identifier") {
        members.unshift(value.property.name);
        value = unwrap(value.object);
      }

      const imported =
        value.type === "Identifier" ? importOf(context.sourceCode.getScope(value), value.name) : undefined;
      const { specifier } = imported ?? {};
      const base =
        imported?.source === EFFECT_ROOT ? [] : imported?.source === CONTEXT_MODULE ? ["Context"] : undefined;

      if (base === undefined || specifier === undefined) {
        return undefined;
      }

      if (specifier.type === "ImportNamespaceSpecifier") {
        return [...base, ...members];
      }

      return specifier.type === "ImportSpecifier"
        ? [...base, moduleExportName(specifier.imported), ...members]
        : undefined;
    }

    // Which Context key a callee declares: `Context.Service`, or `Context.Reference` (effect's
    // `export const Reference = Service`, a service with a default value), whose keys share one space.
    function contextKeyKind(callee: ESTree.Expression): "Service" | "Reference" | undefined {
      const path = effectPath(callee);
      const kind = path?.length === 2 && path[0] === "Context" ? path[1] : undefined;

      return kind === "Service" || kind === "Reference" ? kind : undefined;
    }

    // The key literal of a service declaration: `Context.Service<S, A>()("key")` (the class form),
    // `Context.Service<S>("key")` or `Context.Reference<S>("key", { defaultValue })`.
    function serviceKey(node: ESTree.CallExpression): ESTree.CallExpression["arguments"][number] | undefined {
      const callee = unwrap(node.callee);
      const [first] = node.arguments;
      const declares =
        (callee.type === "CallExpression" &&
          callee.arguments.length === 0 &&
          contextKeyKind(callee.callee) === "Service") ||
        contextKeyKind(callee) !== undefined;

      return declares ? first : undefined;
    }

    function checkServiceKey(key: ESTree.CallExpression["arguments"][number]): void {
      const literal = stringLiteral(key);

      if (literal === undefined) {
        context.report({ node: key, messageId: "literalKey" });
      } else if (namespace !== undefined && !literal.value.startsWith(`${namespace}/`)) {
        context.report({ node: literal, messageId: "serviceKey", data: { value: literal.value, namespace } });
      }
    }

    function checkEvent(literal: ESTree.StringLiteral | undefined): void {
      if (literal === undefined || !VITE_EVENTS.has(literal.value)) {
        check(literal, "a custom HMR event");
      }
    }

    return {
      CallExpression(node) {
        const callee = dottedName(unwrap(node.callee));
        const [first] = node.arguments;

        if (callee === "Symbol.for") {
          check(stringLiteral(first), "a Symbol.for key");
        } else if (shipped && node.callee.type !== "Super") {
          const key = serviceKey(node);

          if (key !== undefined) {
            checkServiceKey(key);
          }
        }

        if (
          callee?.includes(".hot.") === true &&
          HOT_METHODS.has(callee.slice(callee.lastIndexOf(".") + 1))
        ) {
          checkEvent(stringLiteral(first));
        }
      },
      ObjectExpression(node) {
        const meta = propertyNamed(node, "meta");
        const metaValue = meta === undefined ? undefined : unwrap(meta.value);

        if (propertyNamed(node, "rules") && metaValue?.type === "ObjectExpression") {
          check(
            stringLiteral(propertyNamed(metaValue, "name")?.value),
            "a lint plugin's name, the prefix of its rule ids"
          );
        }

        const type = propertyNamed(node, "type");

        if (stringLiteral(type?.value)?.value === "custom") {
          checkEvent(stringLiteral(propertyNamed(node, "event")?.value));
        }
      },
      VariableDeclarator(node) {
        if (
          shipped &&
          node.id.type === "Identifier" &&
          GLOBAL_CONSTANT.test(node.id.name) &&
          node.init !== null
        ) {
          check(stringLiteral(unwrap(node.init)), "the value of a global-name constant");
        }
      },
    };
  },
};
