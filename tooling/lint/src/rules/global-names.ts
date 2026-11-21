// A name in a namespace the whole app shares carries the `elmera-` prefix, so it cannot collide with another library's:
// the oxlint plugin name (the prefix of every rule id an app writes), a `Symbol.for` key, a dev server's custom HMR
// event, and, in the published packages' source, the string constants that name such things (`*_EVENT`, `*_FILE`,
// such as `elmera-intl.json`). Imported names do not need it (`intl()`): the specifier already scopes them. The bin
// and the export conditions live in package.json, which the manifest test checks. Vite's own HMR events keep the names
// Vite gives them, since a listener under any other name never fires.
import type { ESTree, Rule } from "@oxlint/plugins";

import { dottedName, stringLiteral, unwrap } from "../ast.ts";
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
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);
    const shipped = pkg !== undefined && isPublishedSource(pkg, context.filename);

    function check(literal: ESTree.StringLiteral | undefined, what: string): void {
      if (literal !== undefined && !PREFIX.test(literal.value)) {
        context.report({ node: literal, messageId: "prefix", data: { value: literal.value, what } });
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
        } else if (
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
