// A file kept as committed copies of an original holds the original's bytes: the e2e fixture apps each keep the test
// corpus (packages/intl/test/fixtures.tsx) as a real file of their own, because extraction reads only a fixture's own
// files and the packed pass resolves the runtime from the fixture. Nothing else would notice a copy lagging behind the
// original, so this rule holds their content equal from both ends:
//
// - Linting a copy: its text must equal the original's on disk. The fix rewrites the whole copy from the original, so
//   `pnpm lint:fix` is the sync.
// - Linting the original: each listed copy must be a UTF-8 text file equal to it.
//
// The rule owns the content; it cannot own the paths, since it runs only on linted files that match them. The
// `.oxlintrc.json` test in tooling/lint/test/workspace.test.ts does: every configured path names an existing regular
// file by its exact spelling, with no symlink on the way, so a typo or a linked copy fails there.
//
// The paths are relative to the workspace root (the directory holding pnpm-workspace.yaml above the linted file, not
// where lint started), and matched exactly once that root is known. Peers are read from disk on every run, never
// cached, and as bytes that must be valid UTF-8: an editor must not show stale drift, two different files must never
// compare equal through a lossy decode, and the fixer must not write stale or replaced text.
import type { Rule } from "@oxlint/plugins";
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { parseFileCopies, workspaceRootOf } from "../workspace.ts";

// Oxlint's source text omits a byte-order mark and reports it as `hasBOM`; the files on disk keep it.
const BOM = "\uFEFF";

// Where a report on the whole file sits.
const FILE_START = { line: 1, column: 0 } as const;

function forwardSlashes(path: string): string {
  return path.split(sep).join("/");
}

// A peer's text, read fresh as bytes; `undefined` when it is missing, not a file, or not valid UTF-8 (never decoded
// with replacement characters).
function readText(path: string): string | undefined {
  try {
    const bytes = readFileSync(path);

    return isUtf8(bytes) ? bytes.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Reports a listed copy whose text differs from its original, from the copy and from the original; fixes the copy. */
export const fileCopies: Rule = {
  meta: {
    type: "problem",
    docs: { description: "A committed copy of a file holds exactly the original's text." },
    fixable: "code",
    messages: {
      options:
        "elmera-workspace/file-copies' option is invalid: {{reason}}. It takes one { original, copies } object whose paths are relative to the workspace root, inside it, and name distinct files: correct it in .oxlintrc.json.",
      noRoot:
        "This file's path ends with {{path}}, which elmera-workspace/file-copies lists, but no pnpm-workspace.yaml is above it to resolve the rule's workspace-relative paths against.",
      copyDiffers:
        "This file is a copy of {{original}} and differs from it: run `pnpm lint:fix` to rewrite it from the original, and change the original, never the copy.",
      originalUnreadable:
        "This file is a copy of {{original}}, which is missing, not a file, or not valid UTF-8: restore the original, or correct the paths of elmera-workspace/file-copies in .oxlintrc.json.",
      copyStale:
        "{{copy}} is a copy of this file and differs from it: run `pnpm lint:fix` to rewrite the copy from this file, or, when the copy does not parse, `cp {{original}} {{copy}}` from the workspace root.",
      copyMissing:
        "{{copy}}, a copy of this file, is missing or not a UTF-8 text file: restore it with `cp {{original}} {{copy}}` from the workspace root, or correct the paths of elmera-workspace/file-copies in .oxlintrc.json.",
    },
    // The option's structure. The paths' own rules (inside the root, distinct) are the parser's, in workspace.ts.
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: [
        {
          type: "object",
          additionalProperties: false,
          required: ["original", "copies"],
          properties: {
            original: { type: "string" },
            copies: { type: "array", minItems: 1, items: { type: "string" } },
          },
        },
      ],
    },
  },
  create(context) {
    const option = parseFileCopies(context.options);

    if (option._tag === "Invalid") {
      return {
        Program() {
          context.report({ loc: FILE_START, messageId: "options", data: { reason: option.reason } });
        },
      };
    }

    const { original, copies } = option.files;
    const { filename } = context;
    // The cheap gate: a file whose path ends with no listed path skips the root lookup.
    const suffix = [original, ...copies].find((listed) => forwardSlashes(filename).endsWith(`/${listed}`));

    if (suffix === undefined) {
      return {};
    }

    const root = workspaceRootOf(filename);

    if (root === undefined) {
      return {
        Program() {
          context.report({ loc: FILE_START, messageId: "noRoot", data: { path: suffix } });
        },
      };
    }

    // Once the root is known, the file is the original, one listed copy, or neither, by its exact path.
    const path = forwardSlashes(relative(root, filename));

    if (path !== original && !copies.includes(path)) {
      return {};
    }

    return {
      Program() {
        const { sourceCode } = context;
        const text = sourceCode.hasBOM ? `${BOM}${sourceCode.text}` : sourceCode.text;

        if (path !== original) {
          const source = readText(resolve(root, original));

          if (source === undefined) {
            context.report({ loc: FILE_START, messageId: "originalUnreadable", data: { original } });
          } else if (source !== text) {
            context.report({
              loc: FILE_START,
              messageId: "copyDiffers",
              data: { original },
              // The whole file, from before a byte-order mark (offset -1) to the end.
              fix: (fixer) =>
                fixer.replaceTextRange([sourceCode.hasBOM ? -1 : 0, sourceCode.text.length], source),
            });
          }

          return;
        }

        for (const copy of copies) {
          const copied = readText(resolve(root, copy));

          if (copied !== text) {
            context.report({
              loc: FILE_START,
              messageId: copied === undefined ? "copyMissing" : "copyStale",
              data: { copy, original },
            });
          }
        }
      },
    };
  },
};
