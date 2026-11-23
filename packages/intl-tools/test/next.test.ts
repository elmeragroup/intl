import type loadNextConfigType from "next/dist/server/config";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { IntlNextConfig, WithIntlOptions } from "../src/next";
import { withIntl } from "../src/next";

const require = createRequire(import.meta.url);
const NEXT = dirname(require.resolve("next/package.json"));
// SAFETY: Next's config loader as `next build` and `next start` call it; its d.ts is the type.
const { default: loadNextConfig } = require("next/dist/server/config.js") as {
  readonly default: typeof loadNextConfigType;
};

// SAFETY: Next's config schema (a zod schema), which `next build` validates the loaded config against; its d.ts names
// zod's types, which this package does not install, so only the call the tests make is typed.
const { configSchema } = require("next/dist/server/config-schema.js") as {
  readonly configSchema: { readonly safeParse: (config: IntlNextConfig) => { readonly success: boolean } };
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
  expect(() => rulePaths("../messages/{locale}.po", "apps/web")).toThrow(/outside the Turbopack root/u);
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

const REQUEST_MODULE = "@elmeragroup/intl/internal/request-module";

// withIntl's result for the app at apps/web (Next and its intl config installed), with the given request modules below
// the sandbox.
function withIntlFor(
  config: IntlNextConfig,
  options: Pick<WithIntlOptions, "request">,
  modules: ReadonlyArray<string> = []
): IntlNextConfig {
  installNext(".");
  writeIntlConfig("intl/{locale}.po");
  for (const file of modules) {
    mkdirSync(dirname(join(sandbox, file)), { recursive: true });
    writeFileSync(join(sandbox, file), "export default null;\n");
  }

  return withIntl(config, { ...options, dir: join(workspace, "apps/web") });
}

// Unit under test: the Turbopack alias withIntl adds from the runtime's request module to the app's. Oracle: Turbopack's
// alias semantics as Next 16.4.6 applies them (verified on the fixture app, packages/intl-e2e): a relative target
// resolves from the project directory, so the target is that directory's relative path with `./` or `../`, as a plain
// string (only the runtime's react-server request config imports the specifier, so the alias needs no condition); an
// app without a request module at the default path gets no alias (and so the runtime's stub); and Next's own config
// schema accepts the result, which `loadNextConfig({ silent: true })` would not check.
it.each([
  {
    name: "the default module, when it exists",
    config: {},
    options: {},
    modules: ["workspace/apps/web/intl/request.ts"],
    aliases: { [REQUEST_MODULE]: "./intl/request.ts" },
  },
  { name: "nothing, without the default module", config: {}, options: {}, modules: [], aliases: undefined },
  {
    name: "an explicit nested path that does not exist",
    config: {},
    options: { request: "src/i18n/request.ts" },
    modules: [],
    aliases: { [REQUEST_MODULE]: "./src/i18n/request.ts" },
  },
  {
    name: "a module above the project directory inside the Turbopack root",
    config: {},
    options: { request: "../shared/request.ts" },
    modules: ["workspace/apps/shared/request.ts"],
    aliases: { [REQUEST_MODULE]: "../shared/request.ts" },
  },
  // Whether Turbopack resolves the module is Next's to decide (a pruned `next start`, symlinks, additional roots); the
  // stub names the cause when it does not, so withIntl aliases the module wherever it lies.
  {
    name: "an explicit module outside the Turbopack root, without a throw",
    config: { turbopack: { root: "apps/web" } },
    options: { request: "../shared/request.ts" },
    modules: ["workspace/apps/shared/request.ts"],
    aliases: { [REQUEST_MODULE]: "../shared/request.ts" },
  },
  {
    name: "the request module beside the app's own aliases",
    config: { turbopack: { resolveAlias: { underscore: "lodash" } } },
    options: { request: "intl/request.ts" },
    modules: [],
    aliases: { underscore: "lodash", [REQUEST_MODULE]: "./intl/request.ts" },
  },
  {
    name: "idempotently, over the alias it wrote before",
    config: { turbopack: { resolveAlias: { underscore: "lodash", [REQUEST_MODULE]: "./intl/request.ts" } } },
    options: { request: "intl/request.ts" },
    modules: [],
    aliases: { underscore: "lodash", [REQUEST_MODULE]: "./intl/request.ts" },
  },
  // A wildcard is literal outside its `*`s: these miss the specifier (another package, a dot read as itself).
  {
    name: "the request module beside wildcard aliases that do not match it",
    config: {
      turbopack: {
        resolveAlias: {
          "@elmeragroup/intl-tools/*": "./vendor/tools/*",
          "@elmeragroup/intl/internal/request.*": "./x",
        },
      },
    },
    options: { request: "intl/request.ts" },
    modules: [],
    aliases: {
      "@elmeragroup/intl-tools/*": "./vendor/tools/*",
      "@elmeragroup/intl/internal/request.*": "./x",
      [REQUEST_MODULE]: "./intl/request.ts",
    },
  },
  {
    name: "nothing, beside the app's own aliases, without the default module",
    config: { turbopack: { resolveAlias: { underscore: "lodash" } } },
    options: {},
    modules: [],
    aliases: { underscore: "lodash" },
  },
])("aliases $name", ({ config, options, modules, aliases }) => {
  const rooted =
    config.turbopack?.root === undefined
      ? config
      : { ...config, turbopack: { ...config.turbopack, root: join(workspace, config.turbopack.root) } };
  const result = withIntlFor(rooted, options, modules);

  expect(result.turbopack?.resolveAlias).toEqual(aliases);
  expect(result.turbopack !== undefined && "resolveAlias" in result.turbopack).toBe(aliases !== undefined);
  expect(configSchema.safeParse(result).success).toBe(true);
});

// Each would leave the runtime on its stub, or the app's module replaced by another, with no error until a request.
it.each([
  {
    name: "the project directory",
    config: {},
    options: { request: "." },
    modules: [],
    error: /project directory or one above it/u,
  },
  {
    name: "the directory above it",
    config: {},
    options: { request: ".." },
    modules: [],
    error: /project directory or one above it/u,
  },
  {
    name: "another alias for the request module",
    config: { turbopack: { resolveAlias: { [REQUEST_MODULE]: "./src/request.ts" } } },
    options: { request: "intl/request.ts" },
    modules: [],
    error:
      /maps @elmeragroup\/intl\/internal\/request-module to "\.\/src\/request\.ts", which withIntl reserves/u,
  },
  // Turbopack reads a conditional alias differently from the plain target withIntl writes.
  {
    name: "a conditional alias to the same module",
    config: {
      turbopack: { resolveAlias: { [REQUEST_MODULE]: { browser: false, default: "./intl/request.ts" } } },
    },
    options: { request: "intl/request.ts" },
    modules: [],
    error: /maps @elmeragroup\/intl\/internal\/request-module to \{"browser":false/u,
  },
  // withIntl aliases nothing (no request module at the default path), so the entry would stand in for the app's module
  // unchecked.
  {
    name: "an alias for the request module when withIntl aliases none",
    config: { turbopack: { resolveAlias: { [REQUEST_MODULE]: "./intl/request.ts" } } },
    options: {},
    modules: [],
    error:
      /maps @elmeragroup\/intl\/internal\/request-module to "\.\/intl\/request\.ts", which withIntl reserves; .*`request` option/u,
  },
  {
    name: "a conditional alias for the request module when withIntl aliases none",
    config: {
      turbopack: {
        resolveAlias: { underscore: "lodash", [REQUEST_MODULE]: { default: "./src/request.ts" } },
      },
    },
    options: {},
    modules: [],
    error: /which withIntl reserves/u,
  },
  // Turbopack applies a wildcard key to every specifier its pattern matches, so this one supplies another module's
  // config to `getIntl`, beside or instead of withIntl's exact entry.
  {
    name: "a wildcard alias matching the request module",
    config: {
      turbopack: { resolveAlias: { "@elmeragroup/intl/internal/request-mod*": "./intl/review-mod*.ts" } },
    },
    options: { request: "intl/request.ts" },
    modules: [],
    error:
      /maps @elmeragroup\/intl\/internal\/request-module \(through "@elmeragroup\/intl\/internal\/request-mod\*"\) to "\.\/intl\/review-mod\*\.ts", which withIntl reserves/u,
  },
  {
    name: "a wildcard alias matching the request module, beside the default module",
    config: { turbopack: { resolveAlias: { "@elmeragroup/*/request-module": "./intl/request.ts" } } },
    options: {},
    modules: ["workspace/apps/web/intl/request.ts"],
    error: /\(through "@elmeragroup\/\*\/request-module"\)/u,
  },
  {
    name: "a wildcard alias matching the request module when withIntl aliases none",
    config: { turbopack: { resolveAlias: { "@elmeragroup/intl/*": "./vendor/intl/*" } } },
    options: {},
    modules: [],
    error: /\(through "@elmeragroup\/intl\/\*"\) to "\.\/vendor\/intl\/\*", which withIntl reserves/u,
  },
])("rejects $name", ({ config, options, modules, error }) => {
  expect(() => withIntlFor(config, options, modules)).toThrow(error);
});
