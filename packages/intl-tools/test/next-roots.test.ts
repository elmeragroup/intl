import type { NextConfig } from "next";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { withIntl } from "../src/next";

// withIntl's checks that Turbopack can load what the PO loader reads (src/turbopack-roots.ts), through withIntl.

const require = createRequire(import.meta.url);
const NEXT = dirname(require.resolve("next/package.json"));

let sandbox = "";
let workspace = "";
const start = process.cwd();
const argv = process.argv;

// A pnpm workspace with the Next app at apps/web, beside it another directory (its own workspace root), and Next's
// CLI linked as a package manager's `.bin/next` links it, beside a script of the app's own.
beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "elmera-intl-next-roots-")));
  workspace = join(sandbox, "workspace");
  mkdirSync(join(sandbox, "elsewhere"));
  writeFileSync(join(sandbox, "elsewhere/pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(workspace, "apps/web"), { recursive: true });
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: [apps/*]\n");
  mkdirSync(join(sandbox, ".bin"));
  symlinkSync(join(NEXT, "dist/bin/next"), join(sandbox, ".bin/next"));
  mkdirSync(join(sandbox, "scripts"));
  writeFileSync(join(sandbox, "scripts/next.mjs"), "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = argv;
  process.chdir(start);
  rmSync(sandbox, { recursive: true, force: true });
});

// The process next.config loads in: the variables withIntl's gate may read, and argv after Node's own path.
type NextProcess = {
  readonly env: {
    readonly TURBOPACK: string | undefined;
    readonly NEXT_RUNTIME: string | undefined;
    readonly __NEXT_DEV_SERVER: string | undefined;
    // Set only where a row selects Rspack or an adapter.
    readonly NEXT_RSPACK?: string;
    readonly NEXT_ADAPTER_PATH?: string;
  };
  // `{bin}` is Next's CLI through its `.bin/next` link, `{sandbox}` the sandbox.
  readonly argv: ReadonlyArray<string>;
};

// `next build`, as Next 16.4.6 sets it up before it loads next.config (logged from a next.config for #53).
const NEXT_BUILD: NextProcess = {
  env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: undefined },
  argv: ["{bin}", "build"],
};

function runIn(host: NextProcess): void {
  vi.stubEnv("TURBOPACK", host.env.TURBOPACK);
  vi.stubEnv("NEXT_RUNTIME", host.env.NEXT_RUNTIME);
  vi.stubEnv("__NEXT_DEV_SERVER", host.env.__NEXT_DEV_SERVER);
  vi.stubEnv("NEXT_RSPACK", host.env.NEXT_RSPACK);
  vi.stubEnv("NEXT_ADAPTER_PATH", host.env.NEXT_ADAPTER_PATH);
  process.argv = [
    argv[0] ?? "node",
    ...host.argv.map((arg) => arg.replace("{bin}", join(sandbox, ".bin/next")).replace("{sandbox}", sandbox)),
  ];
}

// Installs Next into `node_modules` below the workspace directory `at`.
function installNext(at: string): void {
  mkdirSync(join(workspace, at, "node_modules"), { recursive: true });
  symlinkSync(NEXT, join(workspace, at, "node_modules/next"), "dir");
}

// Writes an intl config with the given catalogs (and formats module), relative to the file, at `at` below the workspace.
function writeIntlConfig(
  catalogs: string,
  {
    at = "apps/web/elmera-intl.json",
    formats,
  }: { readonly at?: string; readonly formats?: string | undefined } = {}
): void {
  mkdirSync(dirname(join(workspace, at)), { recursive: true });
  // JSON leaves out an undefined formats.
  writeFileSync(
    join(workspace, at),
    JSON.stringify({ include: ["app/**/*.tsx"], catalogs, locales: ["nb"], formats })
  );
}

// Writes a formats module at `at` below the workspace.
function writeFormats(at: string): void {
  mkdirSync(dirname(join(workspace, at)), { recursive: true });
  writeFileSync(
    join(workspace, at),
    'export const formats = { number: { price: { style: "currency", currency: "NOK" } } };\n'
  );
}

// A path below the workspace.
function inWorkspace(path: string): string {
  return join(workspace, path);
}

// withIntl on the app at apps/web, given a Next config, with its intl config at `config` (relative to the workspace).
function wrap(next: NextConfig, config: string): () => NextConfig {
  const app = inWorkspace("apps/web");

  return () => withIntl(next, { dir: app, config: relative(app, inWorkspace(config)) });
}

// A Next config's `turbopack.root` and `outputFileTracingRoot`, relative to the workspace, and its
// `experimental.turbopackAdditionalRoots`, by name, with each path as written.
function nextConfig({
  root,
  tracingRoot,
  additionalRoots,
}: {
  readonly root?: string | undefined;
  readonly tracingRoot?: string | undefined;
  readonly additionalRoots?: Readonly<Record<string, string>>;
}): NextConfig {
  const next: NextConfig = {};

  if (root !== undefined) {
    next.turbopack = { root: inWorkspace(root) };
  }

  if (tracingRoot !== undefined) {
    next.outputFileTracingRoot = inWorkspace(tracingRoot);
  }

  if (additionalRoots !== undefined) {
    next.experimental = {
      turbopackAdditionalRoots: Object.fromEntries(
        Object.entries(additionalRoots).map(([name, path]) => [name, { path }])
      ),
    };
  }

  return next;
}

// What a refusal of a file outside Turbopack's roots must say: which file, the root it names and the setting whose
// widening fixes it, and whether listing the file's directory as an additional root would. Paths relative to the
// workspace.
type Refusal = {
  readonly kind: "the intl config" | "the formats module";
  readonly file: string;
  readonly root: string;
  readonly setting: "turbopack.root" | "outputFileTracingRoot";
  readonly listable: boolean;
};

function expectRefusal(run: () => NextConfig, refusal: Refusal): void {
  expect(run).toThrow(
    new RegExp(
      `^withIntl: ${refusal.kind} ${RegExp.escape(inWorkspace(refusal.file))} is outside the Turbopack root ${RegExp.escape(inWorkspace(refusal.root))}(?:,| and its additional roots )`,
      "u"
    )
  );
  expect(run).toThrow(`; set ${refusal.setting} to a directory that holds the app,`);
  expect(run).toThrow(
    refusal.listable
      ? /, or list its directory in experimental\.turbopackAdditionalRoots$/u
      : /its formats module and its catalogs$/u
  );
}

// Unit under test: where withIntl runs the placement checks. Oracle: the #53 replay on Next 16.4.6, which logged the
// environment and argv next.config loads under in each process (NEXT_RUNTIME as logged, though the gate does not read
// it), and Next's own sources: build/index.js compiles in `next build` in the default mode, with a bare
// `--experimental-build-mode` (replayed) and in `compile`, and the `next dev` child and a dev custom server
// (`next({ dev: true })`) compile; `generate` and Turbopack's `generate-env` compile nothing, nor do `next start` (with
// TURBOPACK inherited from a shell or `.env.production` too: replayed), a production custom server (`next({ dev: false
// })`) or `next typegen`. lib/bundler.js picks webpack for `--webpack` before `.env.production` can set TURBOPACK
// (parseBundlerArgs) and Rspack for NEXT_RSPACK (getBundlerFromEnv). bin/next's `--experimental-upload-trace <url>`
// takes the next argument as its value, so `--experimental-upload-trace --experimental-build-mode=compile` leaves an
// earlier `generate` in force. A dev marker inherited into Next's CLI marks no dev server, and a script other than
// Next's CLI given `build` is no evidence of a compile. Where nothing compiles, an app whose intl config lies outside
// the root Next detects there (a deployment copied without its workspace marker) starts.
it.each([
  { name: "next build", host: NEXT_BUILD, refused: true },
  {
    name: "next build --experimental-build-mode compile",
    host: { ...NEXT_BUILD, argv: ["{bin}", "build", "--experimental-build-mode", "compile"] },
    refused: true,
  },
  {
    name: "next build --experimental-build-mode",
    host: { ...NEXT_BUILD, argv: ["{bin}", "build", "--experimental-build-mode"] },
    refused: true,
  },
  {
    name: "next build --experimental-build-mode generate",
    host: { ...NEXT_BUILD, argv: ["{bin}", "build", "--experimental-build-mode", "generate"] },
    refused: false,
  },
  {
    name: "next build --experimental-build-mode=generate-env",
    host: { ...NEXT_BUILD, argv: ["{bin}", "build", "--experimental-build-mode=generate-env"] },
    refused: false,
  },
  {
    name: "next build in generate mode, a compile mode swallowed by --experimental-upload-trace",
    host: {
      ...NEXT_BUILD,
      argv: [
        "{bin}",
        "build",
        "--experimental-build-mode",
        "generate",
        "--experimental-upload-trace",
        "--experimental-build-mode=compile",
      ],
    },
    refused: false,
  },
  {
    name: "next build --experimental-build-mode generate with __NEXT_DEV_SERVER inherited",
    host: {
      env: { ...NEXT_BUILD.env, __NEXT_DEV_SERVER: "1" },
      argv: ["{bin}", "build", "--experimental-build-mode", "generate"],
    },
    refused: false,
  },
  {
    name: "next build --webpack with TURBOPACK from .env.production",
    host: { ...NEXT_BUILD, argv: ["{bin}", "build", "--webpack"] },
    refused: false,
  },
  {
    name: "next build with Rspack selected",
    host: { ...NEXT_BUILD, env: { ...NEXT_BUILD.env, NEXT_RSPACK: "true" } },
    refused: false,
  },
  {
    name: "next build with an adapter selected by NEXT_ADAPTER_PATH",
    host: { ...NEXT_BUILD, env: { ...NEXT_BUILD.env, NEXT_ADAPTER_PATH: "./adapter.mjs" } },
    refused: false,
  },
  {
    name: "a build script other than Next's CLI",
    host: { ...NEXT_BUILD, argv: ["{sandbox}/scripts/next.mjs", "build"] },
    refused: false,
  },
  {
    name: "the next dev child",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: "1" },
      argv: [join(NEXT, "dist/server/lib/start-server.js")],
    },
    refused: true,
  },
  {
    name: "a dev custom server",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: undefined, __NEXT_DEV_SERVER: "1" },
      argv: ["{sandbox}/server-dev.mjs"],
    },
    refused: true,
  },
  {
    name: "next start with TURBOPACK inherited",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: undefined },
      argv: ["{bin}", "start"],
    },
    refused: false,
  },
  {
    name: "next start with TURBOPACK and __NEXT_DEV_SERVER inherited",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: "1" },
      argv: ["{bin}", "start"],
    },
    refused: false,
  },
  {
    name: "a production custom server",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: undefined, __NEXT_DEV_SERVER: undefined },
      argv: ["{sandbox}/server.mjs"],
    },
    refused: false,
  },
  {
    name: "next typegen",
    host: {
      env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: undefined },
      argv: ["{bin}", "typegen"],
    },
    refused: false,
  },
])("checks the config outside the root under $name", ({ host, refused }) => {
  writeIntlConfig("apps/web/intl/{locale}.po", { at: "elmera-intl.json" });
  const run = wrap(nextConfig({ root: "apps/web" }), "elmera-intl.json");
  runIn(host);

  if (refused) {
    expect(run).toThrow(/^withIntl: the intl config .* is outside the Turbopack root /u);
  } else {
    expect(run).not.toThrow();
  }
});

// Unit under test: the adapter skip. Oracle: Next 16.4.6's server/config.js runs the adapter's modifyConfig after it
// evaluates next.config (applyModifyConfig), so an adapter may add the additional root that holds the intl config
// (replayed for #53: such a build compiles the catalog); it selects the adapter by a truthy `adapterPath`, by
// `experimental.adapterPath` (moved to `adapterPath`, warnOptionHasBeenMovedOutOfExperimental), or by
// NEXT_ADAPTER_PATH (config-shared.js's default, in the process matrix).
it.each([
  { name: "adapterPath", next: { adapterPath: "./adapter.mjs" } },
  { name: "experimental.adapterPath", next: { experimental: { adapterPath: "./adapter.mjs" } } },
])("skips the checks under next build with an adapter selected by $name", ({ next }) => {
  writeIntlConfig("apps/web/intl/{locale}.po", { at: "elmera-intl.json" });
  const app = inWorkspace("apps/web");
  runIn(NEXT_BUILD);

  expect(() =>
    withIntl({ ...next, turbopack: { root: app } }, { dir: app, config: "../../elmera-intl.json" })
  ).not.toThrow();
});

// Unit under test: the catalogs check, and where it runs. Oracle: Turbopack resolves no file outside its root, and the
// rule's path condition is relative to it, so a catalog outside could never load; where nothing compiles (`next start`,
// replayed for #53 on a deployment copied without its workspace marker) the app starts.
it("rejects catalogs outside the Turbopack root", () => {
  writeIntlConfig("../messages/{locale}.po");
  runIn(NEXT_BUILD);

  expect(wrap(nextConfig({ root: "apps/web" }), "apps/web/elmera-intl.json")).toThrow(
    `withIntl: the catalogs ../messages/{locale}.po are outside the Turbopack root ${inWorkspace("apps/web")}, and the PO rule matches catalog paths relative to it; set turbopack.root to `
  );
});

it("accepts catalogs outside the Turbopack root under next start", () => {
  writeIntlConfig("../messages/{locale}.po");
  runIn({
    env: { TURBOPACK: "auto", NEXT_RUNTIME: "nodejs", __NEXT_DEV_SERVER: undefined },
    argv: ["{bin}", "start"],
  });

  expect(wrap(nextConfig({ root: "apps/web" }), "apps/web/elmera-intl.json")).not.toThrow();
});

// Unit under test: withIntl's check that Turbopack can load the files the PO loader registers as dependencies of a
// catalog import: the intl config, and the formats module it names. Oracle: Next 16.4.6's Turbopack, replayed for #53:
// a `next build` or `next dev` whose loader registers a file outside turbopack.root fails the catalog import with
// `webpack loader path "<file>" is outside configured roots`, for the config and the formats module alike, while a
// file anywhere inside the root loads. withIntl refuses at config time instead, naming the file. Listing a directory
// as an additional root fixes it only where Next keeps that directory (additional_roots.rs): an existing one (a
// missing one is dropped) that overlaps no root (one that holds the root, a config above the app, is dropped).
it.each([
  {
    name: "the config above the root",
    config: "elmera-intl.json",
    catalogs: "apps/web/intl/{locale}.po",
    formats: undefined,
    root: "apps/web",
    refused: { kind: "the intl config", file: "elmera-intl.json", listable: false },
  },
  {
    name: "the config in a sibling of the root",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    root: "apps/web",
    refused: { kind: "the intl config", file: "shared/elmera-intl.json", listable: true },
  },
  {
    name: "the formats module in a sibling of the root",
    config: "apps/web/elmera-intl.json",
    catalogs: "intl/{locale}.po",
    formats: "../../shared/formats.ts",
    root: "apps/web",
    refused: { kind: "the formats module", file: "shared/formats.ts", listable: true },
  },
  {
    name: "the formats module in a directory that does not exist",
    config: "apps/web/elmera-intl.json",
    catalogs: "intl/{locale}.po",
    formats: "../../shared/later/formats.ts",
    root: "apps/web",
    refused: { kind: "the formats module", file: "shared/later/formats.ts", listable: false },
  },
  {
    name: "the config elsewhere inside the root, outside the app",
    config: "config/intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    root: ".",
    refused: undefined,
  },
  {
    name: "a formats module above the app, inside the root",
    config: "apps/web/elmera-intl.json",
    catalogs: "intl/{locale}.po",
    formats: "../../shared/formats.ts",
    root: ".",
    refused: undefined,
  },
  {
    name: "no formats module",
    config: "apps/web/elmera-intl.json",
    catalogs: "intl/{locale}.po",
    formats: undefined,
    root: "apps/web",
    refused: undefined,
  },
] as const)("checks $name against the Turbopack root", ({ config, catalogs, formats, root, refused }) => {
  writeIntlConfig(catalogs, { at: config, formats });
  writeFormats("shared/formats.ts");
  const run = wrap(nextConfig({ root }), config);
  runIn(NEXT_BUILD);

  if (refused === undefined) {
    expect(run).not.toThrow();
  } else {
    expectRefusal(run, { ...refused, root, setting: "turbopack.root" });
  }
});

// Unit under test: the root the refusal names and the setting it tells the app to widen. Oracle: Next 16.4.6's
// server/config.js: when `outputFileTracingRoot` is set it is Turbopack's root, over a wider `turbopack.root` (with a
// warning when they differ; replayed for #53: a config inside `turbopack.root` and outside `outputFileTracingRoot`
// fails with `outside configured roots`), so widening `turbopack.root` would change nothing; else `turbopack.root` sets
// the root, over Next's own detection (here the workspace, from its pnpm-workspace.yaml).
it.each([
  {
    name: "outputFileTracingRoot, narrower than turbopack.root",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    root: ".",
    tracingRoot: "apps/web",
    refused: { root: "apps/web", setting: "outputFileTracingRoot" },
  },
  {
    name: "turbopack.root alone",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    root: "apps/web",
    tracingRoot: undefined,
    refused: { root: "apps/web", setting: "turbopack.root" },
  },
  {
    name: "Next's detected root",
    config: "../elsewhere/elmera-intl.json",
    catalogs: "../workspace/apps/web/intl/{locale}.po",
    root: undefined,
    tracingRoot: undefined,
    refused: { root: ".", setting: "turbopack.root" },
  },
] as const)("names $name as the root to widen", ({ config, catalogs, root, tracingRoot, refused }) => {
  // Next detects the root only where no setting names one.
  installNext(".");
  writeIntlConfig(catalogs, { at: config });
  const run = wrap(nextConfig({ root, tracingRoot }), config);
  runIn(NEXT_BUILD);

  expectRefusal(run, { kind: "the intl config", file: config, listable: true, ...refused });
});

// Unit under test: the same check, given experimental.turbopackAdditionalRoots. Oracle: Next 16.4.6, by the #53 replay
// and crates/next-api/src/additional_roots.rs: a config or formats module outside turbopack.root but inside an
// additional root loads; a relative additional root resolves from the working directory (`next build proj` launched
// beside `proj` loads a config in `outside` with the root `outside`, and refuses it with `../outside`), through its
// links before `..` (`links/jump/..`, with `jump` a link to `outside/sub`, is `outside`); an additional root that does
// not exist is dropped (`failed to canonicalize`), so a config there fails with `outside configured roots`.
it.each<{
  readonly name: string;
  readonly config: string;
  readonly catalogs: string;
  readonly formats: string | undefined;
  readonly additionalRoots: Readonly<Record<string, string>>;
  readonly launchedFrom: string;
  readonly refused: Omit<Refusal, "root" | "setting"> | undefined;
}>([
  {
    name: "the config in an additional root",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    additionalRoots: { shared: "shared" },
    launchedFrom: "workspace",
    refused: undefined,
  },
  {
    name: "the formats module in an additional root",
    config: "apps/web/elmera-intl.json",
    catalogs: "intl/{locale}.po",
    formats: "../../shared/formats.ts",
    additionalRoots: { shared: "shared" },
    launchedFrom: "workspace",
    refused: undefined,
  },
  {
    name: "the config in a relative additional root, launched from another directory",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    additionalRoots: { shared: "shared" },
    launchedFrom: "elsewhere",
    refused: { kind: "the intl config", file: "shared/elmera-intl.json", listable: true },
  },
  {
    name: "the config in an additional root through a link and `..`",
    config: "outside/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    additionalRoots: { outside: "links/jump/.." },
    launchedFrom: "workspace",
    refused: undefined,
  },
  {
    name: "the config beside an additional root that does not exist",
    config: "shared/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    formats: undefined,
    additionalRoots: { shared: "shared/missing" },
    launchedFrom: "workspace",
    refused: { kind: "the intl config", file: "shared/elmera-intl.json", listable: true },
  },
])(
  "checks $name against the Turbopack roots",
  ({ config, catalogs, formats, additionalRoots, launchedFrom, refused }) => {
    writeIntlConfig(catalogs, { at: config, formats });
    writeFormats("shared/formats.ts");
    mkdirSync(inWorkspace("outside/sub"), { recursive: true });
    mkdirSync(inWorkspace("links"));
    symlinkSync(inWorkspace("outside/sub"), inWorkspace("links/jump"), "dir");
    mkdirSync(join(sandbox, "elsewhere/shared"));
    const run = wrap(nextConfig({ root: "apps/web", additionalRoots }), config);
    runIn(NEXT_BUILD);
    process.chdir(join(sandbox, launchedFrom));

    if (refused === undefined) {
      expect(run).not.toThrow();
    } else {
      expectRefusal(run, { ...refused, root: "apps/web", setting: "turbopack.root" });
    }
  }
);

// Unit under test: the same check, given additional roots only an untyped next.config.mjs can write. Oracle: Next's
// documented shape, `{ [name]: { path } }` (config-shared.d.ts): an entry of another shape names no directory, so it
// widens nothing, and withIntl refuses the config outside the root as with no additional roots, rather than failing on
// the entry with a TypeError.
it("skips additional roots that are not a { path } with a path", () => {
  writeIntlConfig("apps/web/intl/{locale}.po", { at: "elmera-intl.json" });
  runIn(NEXT_BUILD);
  const app = inWorkspace("apps/web");
  const malformed = {
    none: null,
    primitive: 4,
    empty: { path: "" },
    number: { path: 4 },
    object: { path: { __proto__: null } },
  };

  expect(() =>
    withIntl(
      { turbopack: { root: app }, experimental: { turbopackAdditionalRoots: malformed } },
      { dir: app, config: "../../elmera-intl.json" }
    )
  ).toThrow(
    `withIntl: the intl config ${inWorkspace("elmera-intl.json")} is outside the Turbopack root ${app}, so`
  );
});

// Unit under test: the same check, for a config or root reached through a symlink. Oracle: Turbopack at v16.4.6, as
// replayed for #53 (REPLAY.md cases in parentheses): a config linked from inside the root to a file outside it loads
// (c1), as does one through a directory alias of the root and a link out of it (w1); one linked from outside the root
// to a file inside it fails with `outside configured roots` (c2); a config or an additional root spelled through a
// directory alias (macOS's /tmp for /private/tmp) loads (h4b, h1). Turbopack also refuses a directory linked from
// outside strictly into a root (w2), which withIntl leaves to Turbopack's own error.
it.each([
  {
    name: "a config linked from inside the root to a file outside it",
    links: [{ from: "apps/web/linked.json", to: "outside/target.json", type: "file" }],
    config: "apps/web/linked.json",
    written: "outside/target.json",
    // Relative to the link's directory, which the intl config's paths are relative to.
    catalogs: "intl/{locale}.po",
    additionalRoot: undefined,
    refused: undefined,
  },
  {
    name: "a config linked from outside the root to a file inside it",
    links: [{ from: "outside/linked.json", to: "apps/web/target.json", type: "file" }],
    config: "outside/linked.json",
    written: "apps/web/target.json",
    catalogs: "../apps/web/intl/{locale}.po",
    additionalRoot: undefined,
    refused: { listable: true },
  },
  {
    name: "a config spelled through a directory alias of the root",
    links: [{ from: "../alias", to: ".", type: "dir" }],
    config: "../alias/apps/web/elmera-intl.json",
    written: "apps/web/elmera-intl.json",
    // Absolute, so the rule's path, relative to the root, matches.
    catalogs: "{workspace}/apps/web/intl/{locale}.po",
    additionalRoot: undefined,
    refused: undefined,
  },
  {
    name: "a config through a directory alias of the root and a link out of it",
    links: [
      { from: "../alias", to: "apps/web", type: "dir" },
      { from: "apps/web/linkout", to: "outside", type: "dir" },
    ],
    config: "../alias/linkout/elmera-intl.json",
    written: "outside/elmera-intl.json",
    catalogs: "{workspace}/apps/web/intl/{locale}.po",
    additionalRoot: undefined,
    refused: undefined,
  },
  {
    name: "an additional root spelled through a directory alias",
    links: [{ from: "../alias", to: ".", type: "dir" }],
    config: "outside/elmera-intl.json",
    written: "outside/elmera-intl.json",
    catalogs: "../apps/web/intl/{locale}.po",
    additionalRoot: "../alias/outside",
    refused: undefined,
  },
] as const)(
  "checks $name through its links",
  ({ links, config, written, catalogs, additionalRoot, refused }) => {
    writeIntlConfig(catalogs.replace("{workspace}", workspace), { at: written });
    mkdirSync(inWorkspace("outside"), { recursive: true });
    for (const link of links) {
      mkdirSync(dirname(inWorkspace(link.from)), { recursive: true });
      symlinkSync(inWorkspace(link.to), inWorkspace(link.from), link.type);
    }
    const run = wrap(
      nextConfig({
        root: "apps/web",
        additionalRoots: additionalRoot === undefined ? {} : { outside: inWorkspace(additionalRoot) },
      }),
      config
    );
    runIn(NEXT_BUILD);

    if (refused === undefined) {
      expect(run).not.toThrow();
    } else {
      expectRefusal(run, {
        kind: "the intl config",
        file: config,
        root: "apps/web",
        setting: "turbopack.root",
        ...refused,
      });
    }
  }
);
