import type { ESTree, Rule } from "@oxlint/plugins";
// The workspace's dependency direction: intl-e2e → intl-tools → intl, and nothing back.
//
// - Nothing imports @elmeragroup/intl-e2e: it is a test harness.
// - @elmeragroup/intl never imports @elmeragroup/intl-tools: the runtime ships to browsers, the tools to build steps.
// - @elmeragroup/intl/internal/* is for intl-tools (and the runtime itself): it carries no semver promise.
// - The runtime's source imports no Node builtin: every runtime module is platform-neutral, and the client ones reach
//   browsers.
// - In the runtime's source only src/effect.ts, the `/effect` entry, imports `effect` (or an `effect/*` module): it is an
//   optional peer, so every other entry must load without it.
// - A published package's source stays inside its own `src` (a relative import out of it would be bundled into, or
//   break, its dist), and imports a bare package only when its manifest declares it as a dependency or peer, so a
//   consumer's install has it. A type-only import may also come from a devDependency: declarations are inlined.
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";

import { stringLiteral } from "../ast.ts";
import { E2E, isPublishedSource, packageOf, pathInPackage, RUNTIME, TOOLS } from "../workspace.ts";

// The optional peer, and the one runtime module that may import it.
const EFFECT = "effect";
const EFFECT_ENTRY = "src/effect.ts";

// `@scope/name/sub` → `@scope/name`; `name/sub` → `name`.
function packageName(specifier: string): string {
  const [first = "", second = ""] = specifier.split("/");

  return first.startsWith("@") ? `${first}/${second}` : first;
}

/** Reports an import that runs against the workspace's dependency direction. */
export const importBoundaries: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Imports follow the dependency direction intl-e2e → intl-tools → intl." },
    messages: {
      e2e: "Nothing imports @elmeragroup/intl-e2e: it is the private test harness, and nothing depends on it.",
      tools:
        "@elmeragroup/intl never imports @elmeragroup/intl-tools: the runtime ships to browsers, the tools run at build time (the dependency points from intl-tools to intl).",
      internal:
        "`{{specifier}}` is an /internal/ subpath: it exists for @elmeragroup/intl-tools and carries no semver promise. Import a public subpath.",
      builtin:
        "`{{specifier}}` is a Node builtin: @elmeragroup/intl's modules are platform-neutral and reach browsers. Keep Node code in @elmeragroup/intl-tools.",
      outside:
        "`{{specifier}}` leaves this package's src: a published package's source imports only its own src and its dependencies (a path outside would be bundled into its dist).",
      effect:
        "`{{specifier}}` is the optional peer `effect`: in @elmeragroup/intl's source only src/effect.ts (the `/effect` entry) imports it, so every other entry loads without it. Move the Effect code there.",
      undeclared:
        "`{{specifier}}` is not a dependency or peer dependency of {{package}}: a consumer's install would not have it. Declare it, or import it with `import type` when only types are needed.",
    },
    schema: [],
  },
  create(context) {
    const found = packageOf(context.filename);

    if (found === undefined) {
      return {};
    }

    const pkg = found;

    const inRuntime = pkg.name === RUNTIME;
    const mayUseInternal = inRuntime || pkg.name === TOOLS;
    const shipped = isPublishedSource(pkg, context.filename);
    const srcRoot = resolve(pkg.root, "src");
    const inRuntimeSource = inRuntime && pathInPackage(pkg, context.filename).startsWith("src/");
    const isEffectEntry = inRuntime && pathInPackage(pkg, context.filename) === EFFECT_ENTRY;

    function check(source: ESTree.StringLiteral, typeOnly: boolean): void {
      const specifier = source.value;
      const data = { specifier, package: pkg.name ?? "" };

      if (specifier.startsWith(".")) {
        const target = resolve(dirname(context.filename), specifier);

        if (shipped && !`${target}/`.startsWith(`${srcRoot}/`)) {
          context.report({ node: source, messageId: "outside", data });
        }

        return;
      }

      // Aliases a test config maps (`#compile`, `#corpus`): only tests use them, and shipped code may not.
      if (specifier.startsWith("#")) {
        if (shipped) {
          context.report({ node: source, messageId: "outside", data });
        }

        return;
      }

      const name = packageName(specifier);

      if (name === E2E) {
        context.report({ node: source, messageId: "e2e", data });
      } else if (name === TOOLS && inRuntime) {
        context.report({ node: source, messageId: "tools", data });
      } else if (name === RUNTIME && specifier.startsWith(`${RUNTIME}/internal/`) && !mayUseInternal) {
        context.report({ node: source, messageId: "internal", data });
      }

      if (name === EFFECT && inRuntimeSource && !isEffectEntry) {
        context.report({ node: source, messageId: "effect", data });
      }

      if (isBuiltin(specifier)) {
        if (inRuntimeSource) {
          context.report({ node: source, messageId: "builtin", data });
        }

        return;
      }

      if (
        shipped &&
        name !== pkg.name &&
        !pkg.installed.has(name) &&
        !(typeOnly && pkg.development.has(name))
      ) {
        context.report({ node: source, messageId: "undeclared", data });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.importKind === "type"),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.exportKind === "type"),
      ExportAllDeclaration: (node) => check(node.source, node.exportKind === "type"),
      ImportExpression(node) {
        const source = stringLiteral(node.source);

        if (source) {
          check(source, false);
        }
      },
      TSImportType: (node) => check(node.source, true),
    };
  },
};
