import type { NextConfig } from "next";
import type { PHASE_TYPE } from "next/constants";
import * as nextConstants from "next/constants";
import type loadNextConfigType from "next/dist/server/config";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
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

// The phase `next build` loads the config in, where Turbopack compiles.
const BUILD = "phase-production-build";

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

  return poRulePaths(withIntl(config, { dir: join(workspace, "apps/web") })(BUILD));
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

// Unit under test: withIntl's catalogs check. Oracle: Turbopack resolves no file outside its root, so such a catalog
// could never load; Next 16.4.6 makes `outputFileTracingRoot` Turbopack's root when set, over `turbopack.root`
// (server/config.js), so the fix names the setting that decides it.
it.each([
  { setting: "turbopack.root", next: (root: string): IntlNextConfig => ({ turbopack: { root } }) },
  {
    setting: "outputFileTracingRoot",
    next: (root: string): IntlNextConfig => ({ outputFileTracingRoot: root, turbopack: { root: workspace } }),
  },
])("rejects catalogs outside the Turbopack root, naming $setting", ({ setting, next }) => {
  installNext(".");
  writeIntlConfig("../messages/{locale}.po");
  const app = join(workspace, "apps/web");

  expect(() => withIntl(next(app), { dir: app })(BUILD)).toThrow(
    `withIntl: the catalogs ../messages/{locale}.po are outside the Turbopack root ${app}, which resolves no file outside it; set ${setting} to a directory that holds both the app and the catalogs`
  );
});

// Unit under test: withIntl given `experimental` values only an untyped next.config.mjs can write. Oracle: Next's
// documented shape for additional roots is `{ [name]: { path } }` (config-shared.d.ts), and next.config loads in
// processes that compile nothing (`next start`, a custom server), so withIntl reads any other value as no additional
// root rather than failing on it.
it.each([
  { name: "null experimental", experimental: null },
  { name: "a string experimental", experimental: "on" },
  { name: "null additional roots", experimental: { turbopackAdditionalRoots: null } },
  { name: "a string of additional roots", experimental: { turbopackAdditionalRoots: "../shared" } },
  {
    name: "additional roots of no { path } shape, or that do not resolve",
    experimental: {
      turbopackAdditionalRoots: {
        none: null,
        text: "../shared",
        pathless: {},
        numbered: { path: 4 },
        record: { path: { __proto__: null } },
        missing: { path: "/elmera-intl-missing/shared" },
      },
    },
  },
  {
    name: "an experimental whose setting throws when read",
    experimental: {
      get adapterPath(): string {
        throw new Error("read");
      },
    },
  },
  {
    name: "an additional root whose path throws when read",
    experimental: {
      turbopackAdditionalRoots: {
        shared: {
          get path(): string {
            throw new Error("read");
          },
        },
      },
    },
  },
])("accepts $name", ({ experimental }) => {
  // With Next installed, withIntl reads every setting through to Next's own default.
  installNext("apps/web");
  writeIntlConfig("intl/{locale}.po");
  const app = join(workspace, "apps/web");

  expect(() => withIntl({ turbopack: { root: app }, experimental }, { dir: app })(BUILD)).not.toThrow();
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

// Every phase Next defines: the PHASE_* exports of its constants module (shared/lib/constants.js), whose d.ts types
// them as PHASE_TYPE. Read by name, so a phase a later Next adds joins the table below.
const PHASES = Object.entries(nextConstants).flatMap(([name, value]) =>
  // SAFETY: Next's d.ts types each PHASE_* export as one member of PHASE_TYPE, which is what `loadConfig` takes.
  name.startsWith("PHASE_") ? [value as PHASE_TYPE] : []
);
// The phases in which Next 16.4.6 compiles through Turbopack, from its source: `next build` (build/index.js, and its
// Turbopack worker, build/turbopack-build/impl.js) loads the config with PHASE_PRODUCTION_BUILD, `next dev` and a dev
// custom server (server/lib/start-server.js, server/next.js with `dev`) with PHASE_DEVELOPMENT_SERVER, and `next
// analyze` (build/analyze/index.js, which runs turbopackAnalyze) with PHASE_ANALYZE. Every other phase compiles
// nothing: PHASE_PRODUCTION_SERVER (`next start`, a production custom server), PHASE_INFO (`next info`, and `next
// upgrade`'s assessment, lib/upgrade/prepare-upgrade.js), PHASE_TEST (next/jest, build/jest/jest.js, which transforms
// with SWC) and PHASE_EXPORT (export/index.js, handed the build's config by `next build`, so loaded by no command of
// its own). Some commands that compile nothing still load the config with PHASE_PRODUCTION_BUILD, and so are refused as
// a build is: `next typegen`, and `next upgrade --agent` (cli/next-upgrade.js).
const COMPILING = new Set<string>([
  nextConstants.PHASE_PRODUCTION_BUILD,
  nextConstants.PHASE_DEVELOPMENT_SERVER,
  nextConstants.PHASE_ANALYZE,
]);

// What a project can hold that withIntl cannot extend a config from: each is refused where Next compiles, since
// Turbopack then loads no catalog, and is no concern of a process that compiles nothing (a pruned `next start`
// deployment, which need not ship `elmera-intl.json` at all).
const UNREADABLE = [
  {
    state: "catalogs outside the Turbopack root",
    write: () => {
      writeIntlConfig("../../../outside/{locale}.po");
    },
    error: `withIntl: the catalogs ../../../outside/{locale}.po are outside the Turbopack root`,
  },
  { state: "no elmera-intl.json", write: () => undefined, error: "elmera-intl.json not found" },
  {
    state: "an elmera-intl.json that does not parse",
    write: () => {
      writeFileSync(join(workspace, "apps/web/elmera-intl.json"), "{");
    },
    error: "withIntl: not JSON",
  },
];

// Unit under test: withIntl in a next.config.mjs, loaded by Next's own loadConfig in each phase Next defines, with each
// project state withIntl cannot extend a config from. Oracle: the phases that compile, from Next 16.4.6's source (above):
// there withIntl refuses as before, since Turbopack would load no catalog (`Module not found` for a catalog outside the
// root, which exists); in every other phase the config loads with the app's own settings and no `*.po` rule.
it.each(
  PHASES.flatMap((phase) =>
    UNREADABLE.map((unreadable) => ({ phase, ...unreadable, refused: COMPILING.has(phase) }))
  )
)("in $phase, given $state, refuses: $refused", async ({ phase, write, error, refused }) => {
  installNext("apps/web");
  write();
  writeFileSync(join(workspace, "apps/web/package.json"), JSON.stringify({ type: "module" }));
  Object.assign(globalThis, { withIntlUnderTest: withIntl });
  writeFileSync(
    join(workspace, "apps/web/next.config.mjs"),
    "export default globalThis.withIntlUnderTest({ reactStrictMode: true }, { dir: import.meta.dirname });\n"
  );
  const loading = loadNextConfig(phase, join(workspace, "apps/web"), { silent: true });

  if (refused) {
    await expect(loading).rejects.toThrow(error);
  } else {
    const loaded = await loading;

    expect(loaded.reactStrictMode).toBe(true);
    expect(poRulePaths(loaded)).toEqual([]);
  }
});

// Projects whose state refuses in a phase that compiles, and one that does not: what a process that compiles nothing
// may meet (a deployment pruned of its source, started as another user than the one who built it).
const UNREAD: ReadonlyArray<{
  readonly name: string;
  readonly lay: () => { readonly config: NextConfig; readonly options: WithIntlOptions };
  readonly built: "refused" | "extended";
}> = [
  {
    name: "a project directory that does not exist",
    lay: () => ({ config: { reactStrictMode: true }, options: { dir: join(sandbox, "missing") } }),
    built: "refused",
  },
  {
    name: "a request alias withIntl reserves",
    lay: () => {
      installNext(".");
      writeIntlConfig("intl/{locale}.po");

      return {
        config: { turbopack: { resolveAlias: { [REQUEST_MODULE]: "./src/request.ts" } } },
        options: { dir: join(workspace, "apps/web") },
      };
    },
    built: "refused",
  },
  {
    name: "a project withIntl reads",
    lay: () => {
      installNext(".");
      writeIntlConfig("intl/{locale}.po");

      return { config: { reactStrictMode: true }, options: { dir: join(workspace, "apps/web") } };
    },
    built: "extended",
  },
];

// Unit under test: withIntl's phase function in each phase Next defines that compiles nothing. Oracle: Next 16.4.6
// compiles nothing in those phases (from its source, above), so there the phase function reads no file and returns the
// very config passed, whatever the project holds; `next build`'s phase, for the same project, refuses or extends it,
// so each row is a project whose state withIntl reads where it compiles.
it.each(
  PHASES.filter((phase) => !COMPILING.has(phase)).flatMap((phase) => UNREAD.map((row) => ({ phase, ...row })))
)("in $phase, returns the config as passed for $name", ({ phase, lay, built }) => {
  const { config, options } = lay();

  expect(withIntl(config, options)(phase)).toBe(config);
  if (built === "refused") {
    expect(() => withIntl(config, options)(BUILD)).toThrow(/^withIntl: /u);
  } else {
    expect(poRulePaths(withIntl(config, options)(BUILD))).toHaveLength(2);
  }
});

// Unit under test: withIntl's phase function on a project a file system read fails in, as a deployment's process may
// meet one (built as one user, started as another who cannot traverse `intl/`). Oracle: POSIX `stat` of a link to
// itself fails with ELOOP for every user, root included (unlike a mode, which root's CAP_DAC_OVERRIDE ignores): in
// `next build`'s phase withIntl stats the default request module and fails with that error, while in `next start`'s
// phase, which compiles nothing, it reads nothing and returns the very config passed.
it("reads nothing in next start's phase, where next build's fails on the file system", () => {
  installNext(".");
  writeIntlConfig("intl/{locale}.po");
  mkdirSync(join(workspace, "apps/web/intl"));
  symlinkSync("request.ts", join(workspace, "apps/web/intl/request.ts"));
  const config: NextConfig = { reactStrictMode: true };
  const options: WithIntlOptions = { dir: join(workspace, "apps/web") };

  expect(withIntl(config, options)(nextConstants.PHASE_PRODUCTION_SERVER)).toBe(config);
  expect(() => withIntl(config, options)(BUILD)).toThrow(
    /^ELOOP: too many symbolic links encountered, stat /u
  );
});

// Unit under test: withIntl given a value that is no object, as only an untyped next.config.mjs can pass it, loaded
// by Next's own loadConfig. Oracle: a spread of a primitive copies nothing of it, so withIntl refuses it, naming the
// value (a string quoted, a BigInt as it prints, which JSON cannot write), rather than failing on the prototype read
// with a bare TypeError.
it.each([
  {
    name: "a null config",
    source: "null",
    error: "withIntl: the config is null, not an object; pass the config object",
  },
  {
    name: "a null turbopack",
    source: "{ turbopack: null }",
    error: "withIntl: turbopack is null, not an object; pass",
  },
  {
    name: "a string turbopack",
    source: '{ turbopack: "bad" }',
    error: 'withIntl: turbopack is "bad", not an object; pass',
  },
  {
    name: "a BigInt turbopack",
    source: "{ turbopack: 4n }",
    error: "withIntl: turbopack is 4, not an object; pass",
  },
])("rejects $name in a next.config.mjs", async ({ source, error }) => {
  installNext("apps/web");
  writeIntlConfig("intl/{locale}.po");
  writeFileSync(join(workspace, "apps/web/package.json"), JSON.stringify({ type: "module" }));
  Object.assign(globalThis, { withIntlUnderTest: withIntl });
  writeFileSync(
    join(workspace, "apps/web/next.config.mjs"),
    `export default globalThis.withIntlUnderTest(${source}, { dir: import.meta.dirname });\n`
  );

  await expect(
    loadNextConfig("phase-production-build", join(workspace, "apps/web"), { silent: true })
  ).rejects.toThrow(error);
});

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

  return withIntl(config, { ...options, dir: join(workspace, "apps/web") })(BUILD);
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
  // withIntl's own result is a function it refuses, so an entry equal to its target is the app's, not withIntl's.
  {
    name: "an alias for the request module to withIntl's own target",
    config: { turbopack: { resolveAlias: { underscore: "lodash", [REQUEST_MODULE]: "./intl/request.ts" } } },
    options: { request: "intl/request.ts" },
    modules: [],
    error:
      /maps @elmeragroup\/intl\/internal\/request-module to "\.\/intl\/request\.ts", which withIntl reserves/u,
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

// Turbopack settings as a getter, which a spread would not copy.
class ClassTurbopack {
  get root(): string {
    return "/repo";
  }
}

// A config whose settings are a getter and a method, which a spread would not copy.
class ClassConfig {
  get reactStrictMode(): boolean {
    return true;
  }

  generateBuildId(): string {
    return "build";
  }
}

// A class extending null: its prototype ends the chain, and its getter is a setting a spread would not copy.
class NullSettings extends null {
  get reactStrictMode(): boolean {
    return true;
  }
}

class NullTurbopack extends null {
  get root(): string {
    return "/repo";
  }
}

// An object whose settings all live on its prototype.
function inheriting<T extends object>(prototype: T): T {
  // SAFETY: Object.create returns an object whose prototype is `prototype`, so it reads every setting it does.
  return Object.create(prototype) as T;
}

// Unit under test: withIntl's precondition that it can spread what it extends. Oracle: an object spread copies only
// the own enumerable data of its operand, so a function (Next's phase-function config), an array or a class instance
// would lose its call, its elements or its getter and method settings, and a thenable (a Promise, or a plain object
// with a callable `then`) would hand Next a copied `then`, which Next 16.4.6 awaits, loading what it settles to in
// place of withIntl's rule and alias; withIntl refuses each, naming it and the fix, which passes on both arguments
// Next calls a phase function with. Each reaches withIntl as the types let it: through a wrapper generic over NextConfig, which a
// value decorated with a Next setting satisfies, or directly, as a class instance does.
it.each([
  {
    name: "a phase function",
    config: Object.assign((_phase: string) => ({}), { reactStrictMode: true }),
    turbopack: Object.assign(() => ({}), { root: "/repo" }),
    what: "a function",
  },
  {
    name: "a Promise",
    config: Object.assign(Promise.resolve({}), { reactStrictMode: true }),
    turbopack: Object.assign(Promise.resolve({}), { root: "/repo" }),
    what: "a thenable",
  },
  // A plain object with a callable `then`: its spread copies `then`, and Next awaits the result.
  {
    name: "a plain thenable",
    // oxlint-disable-next-line unicorn/no-thenable -- the row is a thenable on purpose: withIntl must refuse one
    config: { reactStrictMode: true, then: (settle: (config: NextConfig) => void) => settle({}) },
    // oxlint-disable-next-line unicorn/no-thenable -- the row is a thenable on purpose: withIntl must refuse one
    turbopack: { root: "/repo", then: (settle: (turbopack: NextConfig["turbopack"]) => void) => settle({}) },
    what: "a thenable",
  },
  // A callable `then` relabelled by `Symbol.toStringTag`: still a function, so still what Next awaits.
  {
    name: "a thenable whose then is tagged as no function",
    config: {
      reactStrictMode: true,
      // oxlint-disable-next-line unicorn/no-thenable -- the row is a thenable on purpose: withIntl must refuse one
      then: Object.assign((settle: (config: NextConfig) => void) => settle({}), {
        [Symbol.toStringTag]: "Settings",
      }),
    },
    turbopack: {
      root: "/repo",
      // oxlint-disable-next-line unicorn/no-thenable -- the row is a thenable on purpose: withIntl must refuse one
      then: Object.assign((settle: (turbopack: NextConfig["turbopack"]) => void) => settle({}), {
        [Symbol.toStringTag]: "Settings",
      }),
    },
    what: "a thenable",
  },
  {
    name: "an array",
    config: Object.assign([], { reactStrictMode: true }),
    turbopack: Object.assign([], { root: "/repo" }),
    what: "an array",
  },
  {
    name: "a class instance with a getter",
    config: new ClassConfig(),
    turbopack: new ClassTurbopack(),
    what: "a class instance",
  },
  // Its prototype ends the chain, as an Object.prototype does, but it is Settings', with the getter on it.
  {
    name: "an instance of a class extending null",
    // An object whose prototype is the class's, which is all an instance is: `new` cannot build one, as a class
    // extending null has no super to construct.
    config: inheriting(NullSettings.prototype),
    turbopack: inheriting(NullTurbopack.prototype),
    what: "a class instance",
  },
  // A null-prototype record as prototype: the settings are inherited, which a spread does not copy.
  {
    name: "an object inheriting from a null-prototype record",
    config: inheriting({ __proto__: null, reactStrictMode: true }),
    turbopack: inheriting({ __proto__: null, root: "/repo" }),
    what: "an object inheriting another object's settings",
  },
])("rejects $name as the config or as turbopack", ({ config, turbopack, what }) => {
  const withApp = <T extends NextConfig>(app: T) => withIntl(app, { dir: join(workspace, "apps/web") });
  // The fix names the phase-function remedy; the remedy test below runs it.
  const fix =
    /; pass the config object itself, and for a phase function call withIntl's result inside it: `[^`]+`$/u;

  expect(() => withApp(config)).toThrow(`withIntl: the config is ${what}, `);
  expect(() => withApp(config)).toThrow(fix);
  expect(() => withApp({ turbopack })).toThrow(`withIntl: turbopack is ${what}, `);
  expect(() => withApp({ turbopack })).toThrow(fix);
});

// Unit under test: the phase-function remedy withIntl's error suggests, taken from the message and run. Oracle: Next
// calls a phase-function config with the phase and a context carrying the default config. The remedy must pass both to
// the app's function and return what withIntl makes of its result, which keeps the app's settings and adds the rules.
it("suggests a phase-function remedy that passes the phase and context through", async () => {
  installNext("apps/web");
  writeIntlConfig("intl/{locale}.po");
  const options: WithIntlOptions = { dir: join(workspace, "apps/web") };
  const withApp = <T extends NextConfig>(app: T) => withIntl(app, options);
  let message = "";
  try {
    withApp(Object.assign((_phase: string) => ({}), { reactStrictMode: true }));
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  const remedy = /`export default (?<source>[^`]+)`$/u.exec(message)?.groups?.source;
  expect(remedy, message).toBeDefined();
  type Context = { readonly defaultConfig: NextConfig };
  // The app's phase function, reading both arguments.
  const config = (phase: string, context: Context): NextConfig => ({
    ...context.defaultConfig,
    reactStrictMode: phase === "phase-production-build",
  });
  // SAFETY: the remedy is the arrow function the message spells, evaluated with the names it uses in scope.
  const run = runInNewContext(`(${remedy})`, { withIntl, config, options }) as (
    phase: string,
    context: Context
  ) => Promise<IntlNextConfig>;
  const result = await run("phase-production-build", { defaultConfig: { poweredByHeader: false } });

  expect(result).toMatchObject({ poweredByHeader: false, reactStrictMode: true });
  expect(poRulePaths(result)).toHaveLength(2);
});

// Unit under test: withIntl's precondition, given plain objects it must accept. Oracle: a spread copies every
// setting of an object with a null prototype, and of an object literal from another realm (a `vm` context; Vitest's
// vmForks pool and a structured clone hand over the same), whose prototype is that realm's `Object.prototype`, not
// this one's.
it.each([
  {
    name: "without a prototype",
    make: (root: string) => {
      const turbopack = { __proto__: null, root };

      return { __proto__: null, turbopack };
    },
    prototype: null,
  },
  {
    name: "from another realm",
    // SAFETY: runInNewContext returns the literal it evaluates, the config shape written beside it.
    make: (root: string) =>
      runInNewContext("({ turbopack: { root } })", { root }) as {
        readonly turbopack: { readonly root: string };
      },
    prototype: "foreign",
  },
])("extends a config and turbopack $name", ({ make, prototype }) => {
  const config = make(workspace);
  const prototypes = [Reflect.getPrototypeOf(config), Reflect.getPrototypeOf(config.turbopack)].map((found) =>
    found === null ? null : found === Object.prototype ? "this realm's" : "foreign"
  );
  const result = withIntlFor(config, {});

  expect(prototypes).toEqual([prototype, prototype]);
  expect(poRulePaths(result)).toHaveLength(2);
});
