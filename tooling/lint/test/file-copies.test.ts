import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import { afterAll, expect, it } from "vitest";

import { fileCopies } from "../src/rules/file-copies.ts";
import { createTester } from "./rule-tester.ts";

// Unit under test: elmera-workspace/file-copies. Oracle: the literal texts below, written to a temporary workspace (a
// directory holding pnpm-workspace.yaml) as the peers the rule reads from disk. A copy must equal ORIGINAL, and its
// fix must produce ORIGINAL exactly. The texts carry `©` and a decomposed `é` (e + U+0301), so a fix that slices by
// bytes or normalizes Unicode would not reproduce them.
const ORIGINAL = `// The corpus ©.\nexport const accent = "e\u0301";\n`;
// The same text with the accent composed (U+00E9): equal to the eye, different in bytes.
const DRIFTED = `// The corpus ©.\nexport const accent = "\u00E9";\n`;
const BOM = "\uFEFF";
// A file whose byte 0xFF is not UTF-8, and the text a lossy decode makes of it (U+FFFD in its place).
const INVALID_UTF8 = Buffer.concat([Buffer.from("// The corpus "), Buffer.from([0xff]), Buffer.from(".\n")]);
const LOSSY = "// The corpus \uFFFD.\n";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "elmera-file-copies-")));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), contents);
}

writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
write("lib/original.ts", ORIGINAL);
write("a/copy.ts", ORIGINAL);
write("b/copy.ts", DRIFTED);
write("bom/original.ts", `${BOM}${ORIGINAL}`);
write("src/corpus.ts", ORIGINAL);
write("fixture/src/corpus.ts", DRIFTED);
write("bad/original.ts", INVALID_UTF8);
write("bad/copy.ts", INVALID_UTF8);
mkdirSync(join(workspace, "link"));
symlinkSync("../lib/original.ts", join(workspace, "link/copy.ts"));
mkdirSync(join(workspace, "dir/copy.ts"), { recursive: true });

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
      name: "Paths written with a leading ./ match the same files",
      code: DRIFTED,
      filename: inWorkspace("b/copy.ts"),
      options: [{ original: "./lib/original.ts", copies: ["./b/copy.ts"] }],
      errors: [{ messageId: "copyDiffers", data: { original: "lib/original.ts" } }],
      output: ORIGINAL,
    },
    {
      name: "A copy whose path ends with the original's path is checked as the copy",
      code: DRIFTED,
      filename: inWorkspace("fixture/src/corpus.ts"),
      options: [{ original: "src/corpus.ts", copies: ["fixture/src/corpus.ts"] }],
      errors: [{ messageId: "copyDiffers", data: { original: "src/corpus.ts" } }],
      output: ORIGINAL,
    },
    {
      name: "The original names each copy that differs or is missing, and fixes nothing",
      code: ORIGINAL,
      filename: inWorkspace("lib/original.ts"),
      options: [{ original: "lib/original.ts", copies: ["a/copy.ts", "b/copy.ts", "gone/copy.ts"] }],
      errors: [
        {
          messageId: "copyStale",
          data: { copy: "b/copy.ts", original: "lib/original.ts" },
          line: 1,
          column: 0,
        },
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
      name: "The original names each copy that is a symlink or a directory",
      code: ORIGINAL,
      filename: inWorkspace("lib/original.ts"),
      options: [{ original: "lib/original.ts", copies: ["link/copy.ts", "dir/copy.ts"] }],
      errors: [
        { messageId: "copyNotRegularFile", data: { copy: "link/copy.ts", original: "lib/original.ts" } },
        { messageId: "copyNotRegularFile", data: { copy: "dir/copy.ts", original: "lib/original.ts" } },
      ],
      output: null,
    },
    {
      name: "A copy that is a symlink to the original is not a copy, and is not fixed",
      code: ORIGINAL,
      filename: inWorkspace("link/copy.ts"),
      options: [{ original: "lib/original.ts", copies: ["link/copy.ts"] }],
      errors: [{ messageId: "notRegularFile", data: { original: "lib/original.ts", copy: "link/copy.ts" } }],
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
      name: "An original that is not valid UTF-8 is unreadable, and no fix is offered from it",
      code: LOSSY,
      filename: inWorkspace("bad/copy.ts"),
      options: [{ original: "bad/original.ts", copies: ["bad/copy.ts"] }],
      errors: [{ messageId: "originalUnreadable", data: { original: "bad/original.ts" } }],
      output: null,
    },
    {
      name: "A copy that is not valid UTF-8 is reported from the original",
      code: LOSSY,
      filename: inWorkspace("bad/original.ts"),
      options: [{ original: "bad/original.ts", copies: ["bad/copy.ts"] }],
      errors: [{ messageId: "copyUnreadable", data: { copy: "bad/copy.ts", original: "bad/original.ts" } }],
      output: null,
    },
    {
      name: "The rule turned on with no option checks nothing, so every file reports it",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      errors: [{ messageId: "options", data: { reason: "it is not one { original, copies } object" } }],
      output: null,
    },
    {
      name: "An option path that leaves the workspace",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      options: [{ original: "lib/original.ts", copies: ["../copy.ts"] }],
      errors: [
        {
          messageId: "options",
          data: { reason: '"../copy.ts" does not name a file inside the workspace root' },
        },
      ],
      output: null,
    },
    {
      name: "An absolute option path",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      options: [{ original: "lib/original.ts", copies: ["/abs/copy.ts"] }],
      errors: [{ messageId: "options", data: { reason: '"/abs/copy.ts" is absolute' } }],
      output: null,
    },
    {
      name: "A copy that is the original",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      options: [{ original: "lib/original.ts", copies: ["./lib/original.ts"] }],
      errors: [{ messageId: "options", data: { reason: 'the copy "./lib/original.ts" is the original' } }],
      output: null,
    },
    {
      name: "Two copies that are the same file",
      code: ORIGINAL,
      filename: inWorkspace("lib/other.ts"),
      options: [{ original: "lib/original.ts", copies: ["a/copy.ts", "a/./copy.ts"] }],
      errors: [{ messageId: "options", data: { reason: 'the copy "a/./copy.ts" is listed twice' } }],
      output: null,
    },
    {
      name: "A listed file with no workspace root above it",
      code: ORIGINAL,
      // A filename RuleTester need not find on disk, in a directory under the filesystem root that no workspace holds.
      filename: resolve("/", "elmera-file-copies-no-workspace-root", "a/copy.ts"),
      options: [pair],
      errors: [{ messageId: "noRoot", data: { path: "a/copy.ts" } }],
      output: null,
    },
  ],
});

// Runs RuleTester's cases now, inside the calling test: its describe and it hooks call their callbacks synchronously,
// and are restored afterwards, so a case's failure (or oxlint's throw) surfaces here.
function runNow(tests: RuleTester.TestCases): void {
  const { describe: describeHook, it: itHook } = RuleTester;

  RuleTester.describe = (_text, fn) => {
    fn();
  };
  RuleTester.it = (_text, fn) => {
    fn();
  };

  try {
    createTester().run("file-copies", fileCopies, tests);
  } finally {
    RuleTester.describe = describeHook;
    RuleTester.it = itHook;
  }
}

it("rejects an option with no copies by its schema, before the rule runs", () => {
  const options = [{ original: "lib/original.ts", copies: [] }];

  expect(() => {
    runNow({ valid: [{ code: ORIGINAL, filename: inWorkspace("a/copy.ts"), options }], invalid: [] });
  }).toThrow(/Options validation failed/u);
});

it("reads the original afresh each time it lints the same copy", () => {
  const fresh = { original: "fresh/original.ts", copies: ["fresh/copy.ts"] };
  const copy = { code: ORIGINAL, filename: inWorkspace("fresh/copy.ts"), options: [fresh] };

  write(fresh.original, ORIGINAL);
  runNow({ valid: [copy], invalid: [] });

  write(fresh.original, DRIFTED);
  runNow({ valid: [], invalid: [{ ...copy, errors: [{ messageId: "copyDiffers" }], output: DRIFTED }] });
});
