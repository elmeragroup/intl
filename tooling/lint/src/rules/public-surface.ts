// The lint-time twin of each published package's public-surface test: a module that a public `exports` subpath maps to
// (through `elmera-source`) exports exactly the runtime names `test/public-surface.json` commits for that subpath.
// Every public export is a semver promise, so adding, renaming or dropping one changes the committed surface on purpose.
// `/internal/*` subpaths carry no promise and are not checked. Types ride along with their subpath and are not listed.
import type { ESTree, Rule } from "@oxlint/plugins";

import { moduleExports } from "../exports.ts";
import { packageOf, readSurface, SURFACE_FILE } from "../workspace.ts";

/** Reports a public entry module whose runtime exports differ from the committed surface. */
export const publicSurface: Rule = {
  meta: {
    type: "problem",
    docs: { description: "A public entry module exports exactly the surface its package commits." },
    messages: {
      extra:
        "`{{name}}` is not in {{subpath}}'s committed surface ({{file}}): add it there on purpose (a public export is a semver promise), or do not export it from this entry.",
      missing:
        "{{subpath}}'s committed surface ({{file}}) lists `{{name}}`, which this entry does not export: export it, or remove it from the surface on purpose.",
      unlisted:
        "{{subpath}} is a public subpath with no entry in {{file}}: commit its runtime exports there ([] for none), or mark it `/internal/`.",
      exportAll:
        "`export *` hides a public entry's surface: name each export, so {{file}} and this module can be compared.",
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);

    if (pkg === undefined || !pkg.published) {
      return {};
    }

    const subpaths = pkg.exports
      .filter((entry) => !entry.subpath.startsWith("./internal/") && entry.sources.includes(context.filename))
      .map((entry) => entry.subpath);

    if (subpaths.length === 0) {
      return {};
    }

    const surface = readSurface(pkg);
    const file = SURFACE_FILE;

    return {
      Program(program: ESTree.Program) {
        const { names: exported, exportAll } = moduleExports(program, context.sourceCode);

        for (const node of exportAll) {
          context.report({ node, messageId: "exportAll", data: { file } });
        }

        for (const subpath of subpaths) {
          const expected = surface?.get(subpath);

          if (expected === undefined) {
            context.report({ node: program, messageId: "unlisted", data: { subpath, file } });
            continue;
          }

          for (const { name, node } of exported) {
            if (!expected.has(name)) {
              context.report({ node, messageId: "extra", data: { name, subpath, file } });
            }
          }

          const names = new Set(exported.map(({ name }) => name));

          for (const name of expected) {
            if (!names.has(name)) {
              context.report({
                loc: { line: 1, column: 0 },
                messageId: "missing",
                data: { name, subpath, file },
              });
            }
          }
        }
      },
    };
  },
};
