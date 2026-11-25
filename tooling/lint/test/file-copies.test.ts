import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fileCopies } from "../src/rules/file-copies.ts";
import { parseFileCopies } from "../src/workspace.ts";
import { createTester } from "./rule-tester.ts";

// Unit under test: elmera-workspace/file-copies. Oracle: the literal texts below, written to a temporary workspace (a
// directory holding pnpm-workspace.yaml) as the peers the rule reads from disk. A copy must equal ORIGINAL, and its
// fix must produce ORIGINAL exactly. The texts carry `©` and a decomposed `é` (e + U+0301), so a fix that slices by
// bytes or normalizes Unicode would not reproduce them.
const ORIGINAL = `// The corpus ©.\nexport const accent = "e\u0301";\n`;
// The same text with the accent composed (U+00E9): equal to the eye, different in bytes.
const DRIFTED = `// The corpus ©.\nexport const accent = "\u00E9";\n`;
const BOM = "\uFEFF";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "elmera-file-copies-")));
// No pnpm-workspace.yaml is above this one.
const outside = realpathSync(mkdtempSync(join(tmpdir(), "elmera-file-copies-outside-")));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
write(workspace, "lib/original.ts", ORIGINAL);
write(workspace, "a/copy.ts", ORIGINAL);
write(workspace, "b/copy.ts", DRIFTED);
write(workspace, "bom/original.ts", `${BOM}${ORIGINAL}`);

const pair = { original: "lib/original.ts", copies: ["a/copy.ts", "b/copy.ts"] };
const inWorkspace = (path: string) => join(workspace, path);

createTester().run("file-copies", fileCopies, {
  valid: [
    {
      name: "A copy equal to the original",
      code: ORIGINAL,
      filename: inWorkspace("a/copy.ts"),
      options: [pair],
    },
    {
      name: "A file the option does not list",
      code: DRIFTED,
      filename: inWorkspace("lib/other.ts"),
      options: [pair],
    },
    {
      name: "A file whose path only ends with a listed one is not that copy, so the fix never rewrites it",
      code: DRIFTED,
      filename: inWorkspace("nested/a/copy.ts"),
      options: [pair],
    },
    {
      name: "An original whose copies all equal it",
      code: ORIGINAL,
      filename: inWorkspace("lib/original.ts"),
      options: [{ ...pair, copies: ["a/copy.ts"] }],
    },
    {
      name: "A copy and an original that both start with a byte-order mark",
      code: `${BOM}${ORIGINAL}`,
      filename: inWorkspace("bom/copy.ts"),
      options: [{ original: "bom/original.ts", copies: ["bom/copy.ts"] }],
    },
  ],
  invalid: [
    {
      name: "A copy that differs is rewritten to the original's text",
      code: DRIFTED,
      filename: inWorkspace("b/copy.ts"),
      options: [pair],
      errors: [{ messageId: "copyDiffers", data: { original: "lib/original.ts" }, line: 1, column: 0 }],
      output: ORIGINAL,
    },
    {
      name: "An empty copy is rewritten to the original's text",
      code: "",
      filename: inWorkspace("b/copy.ts"),
      options: [pair],
      errors: [{ messageId: "copyDiffers" }],
      output: ORIGINAL,
    },
    {
      name: "A byte-order mark the original does not have is part of the difference, and the fix removes it",
      code: `${BOM}${ORIGINAL}`,
      filename: inWorkspace("a/copy.ts"),
      options: [pair],
      errors: [{ messageId: "copyDiffers" }],
      output: ORIGINAL,
    },
    {
      name: "The original names each copy that differs or is missing, and fixes nothing",
      code: ORIGINAL,
      filename: inWorkspace("lib/original.ts"),
      options: [{ original: "lib/original.ts", copies: ["a/copy.ts", "b/copy.ts", "gone/copy.ts"] }],
      errors: [
        { messageId: "copyStale", data: { copy: "b/copy.ts" }, line: 1, column: 0 },
        {
          messageId: "copyMissing",
          data: { copy: "gone/copy.ts", original: "lib/original.ts" },
          line: 1,
          column: 0,
        },
      ],
      output: null,
    },
    {
      name: "A copy whose original cannot be read",
      code: ORIGINAL,
      filename: inWorkspace("a/copy.ts"),
      options: [{ original: "gone/original.ts", copies: ["a/copy.ts"] }],
      errors: [{ messageId: "originalUnreadable", data: { original: "gone/original.ts" } }],
      output: null,
    },
    {
      name: "The rule turned on with no option checks nothing, so every file reports it",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      errors: [{ messageId: "options" }],
      output: null,
    },
    {
      name: "A listed file with no workspace root above it",
      code: ORIGINAL,
      filename: join(outside, "a/copy.ts"),
      options: [pair],
      errors: [{ messageId: "noRoot", data: { path: "a/copy.ts" } }],
      output: null,
    },
  ],
});

// The same copy, linted twice in one process with its original changed on disk in between: each run reads the
// original afresh, so the second sees the change. Each case writes the original it expects before it runs.
const fresh = { original: "fresh/original.ts", copies: ["fresh/copy.ts"] };

createTester().run("file-copies, peers read afresh", fileCopies, {
  valid: [
    {
      name: "The first run, against an equal original",
      code: ORIGINAL,
      filename: inWorkspace("fresh/copy.ts"),
      options: [fresh],
      before: () => {
        write(workspace, fresh.original, ORIGINAL);
      },
    },
  ],
  invalid: [
    {
      name: "The second run sees the original changed on disk",
      code: ORIGINAL,
      filename: inWorkspace("fresh/copy.ts"),
      options: [fresh],
      before: () => {
        write(workspace, fresh.original, DRIFTED);
      },
      errors: [{ messageId: "copyDiffers" }],
      output: DRIFTED,
    },
  ],
});

// A malformed option never reaches the rule through oxlint, whose schema check throws first; the rule's own parser is the
// second line, for an option that check lets through. It admits exactly one object, a non-empty original and at least
// one copy; anything else checks nothing, and the rule reports `options` for it (the RuleTester case above).
describe("parseFileCopies", () => {
  it("parses the one option object", () => {
    expect(parseFileCopies([pair])).toEqual(pair);
  });

  it.each([
    ["two options", [pair, pair]],
    ["no copies", [{ original: "lib/original.ts", copies: [] }]],
    ["an empty path", [{ original: "", copies: ["a/copy.ts"] }]],
    ["a path that is not a string", [{ original: "lib/original.ts", copies: [1] }]],
  ])("rejects %s", (_name, options) => {
    expect(parseFileCopies(options)).toBeUndefined();
  });
});
