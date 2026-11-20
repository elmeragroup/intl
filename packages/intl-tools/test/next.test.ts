import type loadNextConfigType from "next/dist/server/config";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { IntlNextConfig } from "../src/next";
import { withIntl } from "../src/next";

const require = createRequire(import.meta.url);
const NEXT = dirname(require.resolve("next/package.json"));
// SAFETY: Next's config loader as `next build` and `next start` call it; its d.ts is the type.
const { default: loadNextConfig } = require("next/dist/server/config.js") as {
  readonly default: typeof loadNextConfigType;
};

let sandbox = "";
let workspace = "";
const start = process.cwd();

// A pnpm workspace with the Next app at apps/web, and beside it another project (its own workspace root).
beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "elmera-intl-next-")));
  workspace = join(sandbox, "workspace");
  mkdirSync(join(sandbox, "elsewhere"));
  writeFileSync(join(sandbox, "elsewhere/pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(workspace, "apps/web"), { recursive: true });
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: [apps/*]\n");
});

afterEach(() => {
  process.chdir(start);
  rmSync(sandbox, { recursive: true, force: true });
});

// Installs Next into `node_modules` below the workspace directory `at`.
function installNext(at: string): void {
  mkdirSync(join(workspace, at, "node_modules"), { recursive: true });
  symlinkSync(NEXT, join(workspace, at, "node_modules/next"), "dir");
}

function writeIntlConfig(catalogs: string): void {
  writeFileSync(
    join(workspace, "apps/web/elmera-intl.json"),
    JSON.stringify({ include: ["app/**/*.tsx"], catalogs, locales: ["nb"] })
  );
}

// What a Turbopack rule holds: conditions, loader options and paths.
type RuleValue =
  | RegExp
  | ReadonlyArray<RuleValue>
  | { readonly [field: string]: RuleValue }
  | string
  | boolean
  | null;

// The path condition of every rule in a config's rule map.
function poRulePaths(config: IntlNextConfig): ReadonlyArray<RegExp> {
  const found: Array<RegExp> = [];
  // The rule map is opaque to withIntl's types; serializing walks it.
  JSON.stringify(config.turbopack?.rules, (_key: string, value: RuleValue): RuleValue => {
    if (value instanceof RegExp) {
      found.push(value);
    }

    return value;
  });

  return found;
}

// The path condition of every rule withIntl adds, for a Next config with the given Turbopack root (relative to the
// workspace).
function rulePaths(catalogs: string, root?: string): ReadonlyArray<RegExp> {
  installNext(".");
  writeIntlConfig(catalogs);
  const config: IntlNextConfig = root === undefined ? {} : { turbopack: { root: join(workspace, root) } };

  return poRulePaths(withIntl(config, { dir: join(workspace, "apps/web") }));
}

// Unit under test: the Turbopack rule's path condition. Oracle: Next 16.4's root (its config.js and lib/find-root.js):
// `turbopack.root` when set, else the directory of the topmost workspace marker above the app, here the workspace's
// pnpm-workspace.yaml. The condition matches the path relative to that root, so each catalog has exactly one path.
it.each([
  {
    catalogs: "../messages/{locale}.po",
    root: undefined,
    matched: ["apps/messages/nb.po"],
    // A same-named file elsewhere, and the app's own next-intl messages, stay theirs.
    missed: ["messages/nb.po", "apps/web/messages/nb.po", "apps/web/apps/messages/nb.po"],
  },
  {
    catalogs: "../messages/{locale}.po",
    root: "apps",
    matched: ["messages/nb.po"],
    missed: ["apps/messages/nb.po", "web/messages/nb.po"],
  },
  {
    catalogs: "intl/{locale}.po",
    root: undefined,
    matched: ["apps/web/intl/nb.po"],
    missed: ["intl/nb.po", "web/intl/nb.po", "apps/other/intl/nb.po", "apps/web/messages/nb.po"],
  },
  {
    catalogs: "intl/{locale}.po",
    root: "apps/web",
    matched: ["intl/nb.po"],
    missed: ["apps/web/intl/nb.po", "web/intl/nb.po"],
  },
])("matches $catalogs at its one path below root $root", ({ catalogs, root, matched, missed }) => {
  const paths = rulePaths(catalogs, root);

  expect(paths).toHaveLength(2);
  expect(paths.map((path) => [...matched, ...missed].filter((file) => path.test(file)))).toEqual([
    matched,
    matched,
  ]);
});

// Turbopack resolves no file outside its root, so such a catalog could never load.
it("rejects catalogs outside the Turbopack root", () => {
  expect(() => rulePaths("../messages/{locale}.po", "apps/web")).toThrow(/outside the Turbopack root/);
});

// Unit under test: withIntl inside a next.config.mjs, loaded by Next's own loadConfig as `next build apps/web` does,
// with Next installed only in the app and the intl config named by absolute path, so only Next's resolution depends on
// the launch directory. Oracle: the rule matches the catalog's one path below the workspace root (its
// pnpm-workspace.yaml) wherever `next` was launched; `process.cwd()` is the launch directory, not the app's. From
// elsewhere, cwd's root is another project's; from the workspace root, cwd resolves no `next` (outside `pnpm exec`,
// whose NODE_PATH reaches the store's hoisted copy).
it.each([
  { launchedFrom: "workspace" },
  { launchedFrom: "workspace/apps/web" },
  { launchedFrom: "elsewhere" },
])(
  "loads through Next's loadConfig launched from $launchedFrom, with Next only in the app",
  async ({ launchedFrom }) => {
    installNext("apps/web");
    writeIntlConfig("intl/{locale}.po");
    writeFileSync(join(workspace, "apps/web/package.json"), JSON.stringify({ type: "module" }));
    // Next imports the config through Node, which cannot load this package's TypeScript source by its extensionless
    // imports: the config reaches the withIntl under test through a global.
    Object.assign(globalThis, { withIntlUnderTest: withIntl });
    const options = `{ dir: import.meta.dirname, config: ${JSON.stringify(join(workspace, "apps/web/elmera-intl.json"))} }`;
    writeFileSync(
      join(workspace, "apps/web/next.config.mjs"),
      `export default globalThis.withIntlUnderTest({}, ${options});\n`
    );
    process.chdir(join(sandbox, launchedFrom));

    const loaded = await loadNextConfig("phase-production-build", join(workspace, "apps/web"), {
      silent: true,
    });
    const paths = poRulePaths(loaded);

    expect(loaded.turbopack.root).toBe(workspace);
    expect(paths).toHaveLength(2);
    expect(
      paths.map((path) => ["apps/web/intl/nb.po", "intl/nb.po"].filter((file) => path.test(file)))
    ).toEqual([["apps/web/intl/nb.po"], ["apps/web/intl/nb.po"]]);
  }
);
