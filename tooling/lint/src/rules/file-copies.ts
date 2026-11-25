import type { Rule } from "@oxlint/plugins";
// A file kept as committed copies of an original holds the original's bytes: the e2e fixture apps each keep the test
// corpus (packages/intl/test/fixtures.tsx) as a real file of their own, because extraction reads only a fixture's own
// files and the packed pass resolves the runtime from the fixture. Nothing else would notice a copy lagging behind the
// original, so this rule holds them equal from both ends:
//
// - Linting a copy: its text must equal the original's on disk. The fix rewrites the whole copy from the original, so
//   `pnpm lint:fix` is the sync.
// - Linting the original: each listed copy must exist and equal it. A copy that is deleted, renamed or mistyped in the
//   option goes red here, so the rule cannot pass with nothing checked.
//
// The paths are configured once, in `.oxlintrc.json`, relative to the workspace root (the directory holding
// pnpm-workspace.yaml above the linted file, not where lint started). Peers are read from disk on every run, never
// cached: an editor must not show stale drift, and the fixer must not write stale text.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { FileCopies } from "../workspace.ts";
import { parseFileCopies, workspaceRootOf } from "../workspace.ts";

// Oxlint's source text omits a byte-order mark and reports it as `hasBOM`; the files on disk keep it.
const BOM = "\uFEFF";

// Where a report on the whole file sits.
const FILE_START = { line: 1, column: 0 } as const;

type Role = { readonly _tag: "original" } | { readonly _tag: "copy"; readonly path: string };

// The linted file's role, by its path's suffix: the cheap test that lets every other file skip the root lookup. The
// caller confirms the match against the workspace root.
function roleBySuffix(files: FileCopies, filename: string): Role | undefined {
  const path = filename.split(sep).join("/");
  const matches = (listed: string) => path.endsWith(`/${listed}`);

  if (matches(files.original)) {
    return { _tag: "original" };
  }

  const copy = files.copies.find(matches);

  return copy === undefined ? undefined : { _tag: "copy", path: copy };
}

// A peer's text, read fresh; `undefined` when it is missing or cannot be read.
function readPeer(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
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
        "elmera-workspace/file-copies needs one option, { original, copies }, with workspace-relative paths and at least one copy: configure it in .oxlintrc.json.",
      noRoot:
        "{{path}} is listed by elmera-workspace/file-copies, but no pnpm-workspace.yaml is above this file to resolve the rule's workspace-relative paths against.",
      copyDiffers:
        "This file is a copy of {{original}} and differs from it: run `pnpm lint:fix` to rewrite it from the original, and change the original, never the copy.",
      originalUnreadable:
        "This file is a copy of {{original}}, which cannot be read: restore the original, or correct the paths of elmera-workspace/file-copies in .oxlintrc.json.",
      copyStale:
        "{{copy}} is a copy of this file and differs from it: run `pnpm lint:fix` to rewrite the copy from this file.",
      copyMissing:
        "{{copy}}, a copy of this file, is missing: restore it with `cp {{original}} {{copy}}` from the workspace root, or correct the paths of elmera-workspace/file-copies in .oxlintrc.json.",
    },
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
            original: { type: "string", minLength: 1 },
            copies: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      ],
    },
  },
  create(context) {
    const files = parseFileCopies(context.options);

    if (files === undefined) {
      return {
        Program() {
          context.report({ loc: FILE_START, messageId: "options" });
        },
      };
    }

    const { filename } = context;
    const role = roleBySuffix(files, filename);

    if (role === undefined) {
      return {};
    }

    const listed = role._tag === "original" ? files.original : role.path;
    const root = workspaceRootOf(filename);

    if (root === undefined) {
      return {
        Program() {
          context.report({ loc: FILE_START, messageId: "noRoot", data: { path: listed } });
        },
      };
    }

    // A file that only shares the suffix, such as a nested workspace's own path, is not the listed one.
    if (resolve(root, listed) !== filename) {
      return {};
    }

    return {
      Program() {
        const { sourceCode } = context;
        const text = sourceCode.hasBOM ? `${BOM}${sourceCode.text}` : sourceCode.text;

        if (role._tag === "copy") {
          const original = readPeer(resolve(root, files.original));

          if (original === undefined) {
            context.report({
              loc: FILE_START,
              messageId: "originalUnreadable",
              data: { original: files.original },
            });
          } else if (original !== text) {
            context.report({
              loc: FILE_START,
              messageId: "copyDiffers",
              data: { original: files.original },
              // The whole file, from before a byte-order mark (offset -1) to the end.
              fix: (fixer) =>
                fixer.replaceTextRange([sourceCode.hasBOM ? -1 : 0, sourceCode.text.length], original),
            });
          }

          return;
        }

        for (const copy of files.copies) {
          const copied = readPeer(resolve(root, copy));

          if (copied === undefined) {
            context.report({
              loc: FILE_START,
              messageId: "copyMissing",
              data: { copy, original: files.original },
            });
          } else if (copied !== text) {
            context.report({ loc: FILE_START, messageId: "copyStale", data: { copy } });
          }
        }
      },
    };
  },
};
