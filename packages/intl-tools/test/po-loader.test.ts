import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import { CatalogCompileError } from "../src/compile";
import type { IntlNextConfig, PoLoaderOptions } from "../src/next";
import { withIntl } from "../src/next";
import { formatPo } from "../src/po";
import poLoader from "../src/po-loader";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

const require = createRequire(import.meta.url);
const NEXT = dirname(require.resolve("next/package.json"));
const SOURCE = "{n, number, money}";
const PO = formatPo("nb", [
  {
    source: SOURCE,
    context: undefined,
    translation: `${SOURCE} totalt`,
    references: [],
    comments: [],
    flags: [],
  },
]);

// Each test owns its project (see `Project`); every wait ends by its deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-po-loader-", task.timeout);
  onCleanup(close);

  return project;
});

/** What one loader call handed the bundler. */
type Loaded = {
  readonly error: Error | null;
  readonly code: string | undefined;
  /** The paths `addDependency` was given by the time the callback ran: Turbopack reads them there. */
  readonly dependencies: ReadonlySet<string>;
};

// Turbopack's webpack-loader call: the loader's options, the file (relative to the project, or absolute), and its result
// through `async()`.
async function load(project: Project, resource: string, given?: PoLoaderOptions): Promise<Loaded> {
  const options = given ?? { config: project.path("elmera-intl.json"), source: false };
  const done = Promise.withResolvers<Loaded>();
  const dependencies: Array<string> = [];
  poLoader.call(
    {
      resourcePath: resolve(project.path("."), resource),
      getOptions: () => options,
      addDependency: (file) => {
        dependencies.push(file);
      },
      async: () => (error, code) => {
        done.resolve({ error, code, dependencies: new Set(dependencies) });
      },
    },
    PO
  );

  return project.within(done.promise, "the loader's callback");
}

// The nb project whose formats module defines `money` in `currency`. One module path, rewritten: a dev server's loader
// sees the same module change.
function useMoney(project: Project, currency: string): void {
  project.write(
    "formats.ts",
    `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`
  );
  project.write(
    "elmera-intl.json",
    JSON.stringify({
      include: ["*.ts"],
      catalogs: "intl/{locale}.po",
      locales: ["nb"],
      formats: "formats.ts",
    })
  );
}

// Unit under test: the Turbopack loader, through the webpack-loader API it implements. Oracle: Intl's own nb currency
// format, and its rejection of the currency "NOKK", which only the formats module the config names makes reachable;
// by its callback, a load has registered the config and that module as dependencies, whether it compiles or fails.
it("compiles the PO with the config's formats module, and fails a style only its edited content makes invalid", async ({
  project,
}) => {
  useMoney(project, "NOK");
  const { error, code, dependencies } = await load(project, "intl/nb.po");
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`);
  const exported = new Map<string, unknown>(Object.entries(new Object(module))).get("default");
  // SAFETY: the loader's module default is the compiled catalog this test renders; a wrong value fails the render.
  const catalog = exported as Catalog;
  const formats = { number: { money: { style: "currency", currency: "NOK" } } } as const;
  const both = new Set([project.path("elmera-intl.json"), project.path("formats.ts")]);

  expect(error).toBeNull();
  expect(createIntl({ locale: "nb", catalog, timeZone: "UTC", formats }).t(SOURCE, { n: 1234.5 })).toBe(
    `${new Intl.NumberFormat("nb", { style: "currency", currency: "NOK" }).format(1234.5)} totalt`
  );
  expect(dependencies).toEqual(both);

  useMoney(project, "NOKK");
  const failed = await load(project, "intl/nb.po");

  expect(failed.error).toBeInstanceOf(CatalogCompileError);
  expect(failed.error?.message).toMatch(/"\{n, number, money\}": Invalid currency code : NOKK/u);
  expect(failed.dependencies).toEqual(both);
});

// Unit under test: the loader on a PO no configured locale's catalog is. Oracle: the one rule for the text a PO of no
// configured locale fails with on every host (`elmera-intl:`, the PO's path relative to the config, the catalogs
// pattern and the locales), written out for this fixture; and by its callback the load has registered the config, the
// only file whose edit can repair it, as a dependency.
it("fails a PO of no configured locale, depending on the config", async ({ project }) => {
  useMoney(project, "NOK");
  const { error, dependencies } = await load(project, "intl/sv.po");

  expect(error?.message).toBe("elmera-intl: intl/sv.po is not a configured catalog (intl/{locale}.po, nb)");
  expect(dependencies).toEqual(new Set([project.path("elmera-intl.json")]));
});

// Unit under test: the loader under a config that does not parse. Oracle: the config is the only file whose edit can
// repair the load, so by its callback the failed load has registered it as a dependency. The failure's text is
// load-graph.test.ts's.
it("fails under an invalid config, depending on the config", async ({ project }) => {
  project.write("elmera-intl.json", "{");
  const { error, dependencies } = await load(project, "intl/nb.po");

  expect(error).not.toBeNull();
  expect(dependencies).toEqual(new Set([project.path("elmera-intl.json")]));
});

// A project laid out for the placement rows: the Next app, which is Turbopack's root, at `app`, with its catalogs at
// `app/intl`, and outside the root the directories `outside` and `other`.
type Placement = {
  /** The intl config's path as `withIntl` is given it, relative to the project. */
  readonly config: string;
  /** Where the config's JSON is written, when `config` is a link to it or runs through one. */
  readonly written?: string;
  /** The formats module the config names, relative to the project. */
  readonly formats: string;
  /** The catalogs as the config names them; `app/intl/{locale}.po` by its absolute path by default. */
  readonly catalogs?: string;
  /** Links made before `withIntl` runs: `from` is a link to `to`, both relative to the project. */
  readonly links?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly type: "file" | "dir";
  }>;
  /** The Next config's root settings and its `experimental` and `adapterPath`, for the project. */
  readonly next: (project: Project) => RowNextConfig;
  /** `NEXT_ADAPTER_PATH`, Next's default for `adapterPath`. */
  readonly adapterEnv?: string;
  /** The imported PO, relative to the project. */
  readonly resource?: string;
  /** The rule the import goes through: the catalog's, or `?source`'s, which compiles the msgids as English. */
  readonly query?: "catalog" | "source";
  /** The working directory withIntl runs in, relative to the project; the project itself by default. */
  readonly launchedFrom?: string;
  /** withIntl's `dir`, as given; the app's absolute path by default. */
  readonly dir?: string;
};

// The Next settings a row gives withIntl: its roots, and the `experimental` and `adapterPath` only an untyped
// next.config.mjs can write in the shapes some rows use.
type RowNextConfig = IntlNextConfig & { readonly experimental?: unknown; readonly adapterPath?: string };

// What a row hides: an additional roots map, one entry of it, or an entry's path.
type Hidden = { readonly [name: string]: { readonly path: string } } | { readonly path: string } | string;

// `object` with `key` defined as a non-enumerable own data property, as an untyped next.config.mjs may define it.
function hidden<O extends object>(object: O, key: string, value: Hidden): O {
  return Object.defineProperty(object, key, { value });
}

// Lays a row out, wraps its Next config with withIntl as next.config would, and runs the PO loader with the options of
// the rule withIntl wrote for the catalog import (not `?source`).
async function loadPlaced(project: Project, placement: Placement): Promise<Loaded> {
  project.write(
    placement.written ?? placement.config,
    JSON.stringify({
      include: ["*.ts"],
      // Absolute: a config spelled through an alias lies lexically outside the root it names its catalogs in.
      catalogs: placement.catalogs ?? project.path("app/intl/{locale}.po"),
      locales: ["nb"],
      formats: project.path(placement.formats),
    })
  );
  mkdirSync(project.path("outside"), { recursive: true });
  mkdirSync(project.path("other"), { recursive: true });
  for (const link of placement.links ?? []) {
    mkdirSync(project.path(`${link.from}/..`), { recursive: true });
    if (link.type === "dir") {
      mkdirSync(project.path(link.to), { recursive: true });
    }
    symlinkSync(project.path(link.to), project.path(link.from), link.type);
  }

  const app = project.path("app");
  mkdirSync(project.path("app/node_modules"), { recursive: true });
  symlinkSync(NEXT, project.path("app/node_modules/next"), "dir");
  // Next reads NEXT_ADAPTER_PATH into its default config once, when the CLI first evaluates config-shared.js, before
  // next.config: the module is evaluated afresh under this row's variable, which is gone again by the time withIntl
  // runs, and dropped for the next row.
  const appRequire = createRequire(join(app, "package.json"));
  const configShared = appRequire.resolve("next/dist/server/config-shared.js");
  const forget = () => {
    Reflect.deleteProperty(require.cache, configShared);
  };
  forget();
  project.defer(forget);
  vi.stubEnv("NEXT_ADAPTER_PATH", placement.adapterEnv);
  appRequire(configShared);
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_ADAPTER_PATH", undefined);
  project.defer(() => {
    vi.unstubAllEnvs();
  });
  const start = process.cwd();
  const cwd = project.path(placement.launchedFrom ?? ".");
  process.chdir(cwd);
  let wrapped: RowNextConfig;
  try {
    // In the phase of `next build`, which compiles the import.
    wrapped = withIntl(placement.next(project), {
      dir: placement.dir ?? app,
      config: relative(resolve(cwd, placement.dir ?? app), project.path(placement.config)),
    })("phase-production-build");
  } finally {
    process.chdir(start);
  }
  // Written once next.config is evaluated: withIntl reads no formats module, and a row may place it in a directory
  // the build makes later.
  project.write(
    placement.formats,
    `export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`
  );
  // SAFETY: the `*.po` rules withIntl writes (next.ts, poRule); another shape fails the lookup below.
  const rules = new Map(Object.entries(wrapped.turbopack?.rules ?? {})).get("*.po") as ReadonlyArray<{
    readonly loaders: readonly [{ readonly options: PoLoaderOptions }];
  }>;
  const options = rules
    .map((rule) => rule.loaders[0].options)
    .find((candidate) => candidate.source === (placement.query === "source"));

  if (options === undefined) {
    throw new Error("withIntl wrote no rule for the catalog import");
  }

  // Turbopack hands the loader the imported file's real path (replayed for #63: the resource of `../intl/nb.po` under
  // a root spelled through no link), not the spelling of the config or the project's temporary directory.
  return load(
    project,
    join(realpathSync(project.path(".")), placement.resource ?? "app/intl/nb.po"),
    options
  );
}

// Unit under test: the placement problem a refused import fails with. Oracle: the tools' problem form (problem.ts,
// describeProblem): the file, the code, what is wrong (which file is outside which root), and the fix on its own line,
// naming the setting that decides the root and the additional roots Next reads.
it("fails a config outside the root with the placement problem", async ({ project }) => {
  const { error } = await loadPlaced(project, {
    config: "outside/elmera-intl.json",
    formats: "app/formats.ts",
    next: (laidOut) => ({ turbopack: { root: laidOut.path("app") } }),
  });

  expect(error?.message).toBe(
    `${project.path("outside/elmera-intl.json")}: OutsideTurbopackRoots: the intl config is outside the Turbopack root ${project.path("app")}, so Turbopack cannot load it as a dependency of this catalog import\n  fix: set turbopack.root to a directory that holds the app, the intl config, its formats module and its catalogs, or list a directory that holds the file, and neither holds nor lies in the Turbopack root, in experimental.turbopackAdditionalRoots`
  );
});

// A refusal's parts a row checks: each file left unregistered, as the intl config or the formats module, outside which
// roots (relative to the project), and the setting the fix names.
type Refusal = {
  readonly outside: ReadonlyArray<{
    readonly file: string;
    readonly what: "the intl config" | "the formats module";
  }>;
  readonly roots: (project: Project) => string;
  readonly setting: "turbopack.root" | "outputFileTracingRoot";
};

const OUTSIDE_APP = (project: Project) => `the Turbopack root ${project.path("app")}`;

// Unit under test: the PO loader, given the options withIntl's rule hands it. Oracle: Next 16.4.6's Turbopack, replayed
// for #53: a loader dependency outside the roots fails the import with Turbopack's own `outside configured roots`, in
// place of the import's outcome (the import of a PO of no configured locale too), for the config and the formats module
// alike; its check is lexical on the registered path, with the directories above it resolved through their links, so a
// config linked from outside the root to a file inside it is refused (c2). Turbopack's root is `outputFileTracingRoot`
// when set, over `turbopack.root` (Next's server/config.js). The loader registers no file outside and fails with one
// problem for each, naming the setting; it still registers the files inside, whose edit reruns the import.
it.for<{
  readonly name: string;
  readonly placement: Placement;
  readonly registered: ReadonlyArray<string>;
  readonly refusal: Refusal;
}>([
  {
    name: "the config outside the root, importing a PO of no configured locale",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
      resource: "app/intl/sv.po",
    },
    registered: [],
    refusal: {
      outside: [{ file: "outside/elmera-intl.json", what: "the intl config" }],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    name: "the formats module outside the root",
    placement: {
      config: "app/elmera-intl.json",
      formats: "outside/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
    registered: ["app/elmera-intl.json"],
    refusal: {
      outside: [{ file: "outside/formats.ts", what: "the formats module" }],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    name: "the formats module outside the root, imported through ?source",
    placement: {
      config: "app/elmera-intl.json",
      formats: "outside/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
      query: "source",
    },
    registered: ["app/elmera-intl.json"],
    refusal: {
      outside: [{ file: "outside/formats.ts", what: "the formats module" }],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    // `dir` relative to the working directory, as `next.config` may pass `"."` beside an absolute root.
    name: "the config outside the root, given a relative project directory",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
      launchedFrom: "app",
      dir: ".",
    },
    registered: ["app/formats.ts"],
    refusal: {
      outside: [{ file: "outside/elmera-intl.json", what: "the intl config" }],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    name: "the config and the formats module outside the root",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "outside/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
    registered: [],
    refusal: {
      outside: [
        { file: "outside/elmera-intl.json", what: "the intl config" },
        { file: "outside/formats.ts", what: "the formats module" },
      ],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    name: "the config linked from outside the root to a file inside it",
    placement: {
      config: "outside/linked.json",
      written: "app/target.json",
      links: [{ from: "outside/linked.json", to: "app/target.json", type: "file" }],
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
    registered: ["app/formats.ts"],
    refusal: {
      outside: [{ file: "outside/linked.json", what: "the intl config" }],
      roots: OUTSIDE_APP,
      setting: "turbopack.root",
    },
  },
  {
    name: "the config inside turbopack.root but outside a narrower outputFileTracingRoot",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ outputFileTracingRoot: project.path("app"), turbopack: { root: project.root } }),
    },
    registered: ["app/formats.ts"],
    refusal: {
      outside: [{ file: "outside/elmera-intl.json", what: "the intl config" }],
      roots: OUTSIDE_APP,
      setting: "outputFileTracingRoot",
    },
  },
  {
    // Additional roots as Next resolves them (through their links); entries of no `{ path }` shape, or whose path does
    // not resolve, Next drops, so they widen nothing.
    name: "the config outside the root and its additional roots, beside entries Next drops",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: {
          turbopackAdditionalRoots: {
            other: { path: project.path("other") },
            none: null,
            text: project.path("outside"),
            pathless: {},
            numbered: { path: 4 },
            missing: { path: project.path("outside/missing") },
          },
        },
      }),
    },
    registered: ["app/formats.ts"],
    refusal: {
      outside: [{ file: "outside/elmera-intl.json", what: "the intl config" }],
      roots: (project) =>
        `the Turbopack root ${project.path("app")} and its additional roots ${realpathSync(project.path("other"))}, ${project.path("outside/missing")}`,
      setting: "turbopack.root",
    },
  },
])(
  "refuses $name, registering only the files inside",
  async ({ placement, registered, refusal }, { project }) => {
    const { error, code, dependencies } = await loadPlaced(project, placement);
    const message = error?.message ?? "";

    expect(code).toBeUndefined();
    expect(message.match(/: OutsideTurbopackRoots: /gu)).toHaveLength(refusal.outside.length);
    for (const { file, what } of refusal.outside) {
      expect(message).toContain(
        `${project.path(file)}: OutsideTurbopackRoots: ${what} is outside ${refusal.roots(project)}, `
      );
    }
    expect(message).toContain(`\n  fix: set ${refusal.setting} to `);
    expect(dependencies).toEqual(new Set(registered.map((file) => project.path(file))));
  }
);

// Unit under test: the same loader, on layouts Turbopack loads. Oracle: Next 16.4.6's Turbopack, replayed for #53
// (REPLAY.md cases in parentheses): a config and formats module inside the root load; so does each inside an
// additional root (d1, d2), which Next resolves through its links before `..` (crates/next-api/src/additional_roots.rs)
// and through a directory alias of it (h1); a config linked from inside the root to a file outside it (c1); one spelled
// through a directory alias of the root (h4b; with catalogs relative to it, h3 and h4 of #63, which Turbopack imports
// at their real path), and through that alias and a link out of the root (w1). An adapter's
// modifyConfig runs after next.config and may add roots (server/config.js, applyModifyConfig), and Next selects one by
// `adapterPath`, by `experimental.adapterPath` or by NEXT_ADAPTER_PATH (config-shared.js), so with an adapter a config
// outside the root loads (ad1, ad3). Each registers the config and the formats module, as before.
it.for<{ readonly name: string; readonly placement: Placement }>([
  {
    name: "the config and the formats module inside the root",
    placement: {
      config: "app/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
  },
  {
    name: "the config in an additional root",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { outside: { path: project.path("outside") } } },
      }),
    },
  },
  {
    // Next reads its settings by name: its config clone keeps non-enumerable own settings (server/config.js).
    name: "the config in an additional root that experimental holds as a non-enumerable setting",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: hidden({}, "turbopackAdditionalRoots", { outside: { path: project.path("outside") } }),
      }),
    },
  },
  {
    name: "the config in an additional root under a non-enumerable name",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: hidden({}, "outside", { path: project.path("outside") }) },
      }),
    },
  },
  {
    name: "the config in an additional root whose path is non-enumerable",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { outside: hidden({}, "path", project.path("outside")) } },
      }),
    },
  },
  {
    // An additional root the build makes after next.config is evaluated, before Turbopack starts.
    name: "the formats module in an additional root made after next.config is evaluated",
    placement: {
      config: "app/elmera-intl.json",
      formats: "later/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { later: { path: project.path("later") } } },
      }),
    },
  },
  {
    name: "the formats module in an additional root",
    placement: {
      config: "app/elmera-intl.json",
      formats: "outside/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { outside: { path: project.path("outside") } } },
      }),
    },
  },
  {
    // Relative, from the working directory (the project's, while withIntl runs), as Next resolves it; from the app's
    // directory it would name no directory.
    name: "the config in a relative additional root named through a link and `..`",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      links: [{ from: "links/jump", to: "outside/sub", type: "dir" }],
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { outside: { path: "links/jump/.." } } },
      }),
    },
  },
  {
    name: "the config in an additional root named through a directory alias",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      links: [{ from: "alias", to: ".", type: "dir" }],
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { turbopackAdditionalRoots: { outside: { path: project.path("alias/outside") } } },
      }),
    },
  },
  {
    name: "the config linked from inside the root to a file outside it",
    placement: {
      config: "app/linked.json",
      written: "outside/target.json",
      links: [{ from: "app/linked.json", to: "outside/target.json", type: "file" }],
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
  },
  {
    name: "the config spelled through a directory alias of the root",
    placement: {
      config: "alias/elmera-intl.json",
      written: "app/elmera-intl.json",
      links: [{ from: "alias", to: "app", type: "dir" }],
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
  },
  // The catalogs relative to the config, so as the config spells them they lie in the alias, where the rule's real
  // path pattern never finds them (#63).
  {
    name: "the config spelled through a directory alias of the root, with catalogs relative to it",
    placement: {
      config: "alias/elmera-intl.json",
      written: "app/elmera-intl.json",
      catalogs: "intl/{locale}.po",
      links: [{ from: "alias", to: "app", type: "dir" }],
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
  },
  {
    name: "the config through a directory alias of the root and a link out of it",
    placement: {
      config: "alias/linkout/elmera-intl.json",
      written: "outside/elmera-intl.json",
      links: [
        { from: "alias", to: "app", type: "dir" },
        { from: "app/linkout", to: "outside", type: "dir" },
      ],
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
    },
  },
  {
    name: "the config outside the root with an adapter selected by adapterPath",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") }, adapterPath: "./adapter.mjs" }),
    },
  },
  {
    name: "the config outside the root with an adapter selected by experimental.adapterPath",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({
        turbopack: { root: project.path("app") },
        experimental: { adapterPath: "./adapter.mjs" },
      }),
    },
  },
  {
    name: "the config outside the root with an adapter selected by NEXT_ADAPTER_PATH",
    placement: {
      config: "outside/elmera-intl.json",
      formats: "app/formats.ts",
      next: (project) => ({ turbopack: { root: project.path("app") } }),
      adapterEnv: "./adapter.mjs",
    },
  },
])("loads $name", async ({ placement }, { project }) => {
  const { error, code, dependencies } = await loadPlaced(project, placement);

  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`);

  expect(error).toBeNull();
  expect(new Map(Object.entries(new Object(module))).get("default")).toBeTypeOf("object");
  expect(dependencies).toEqual(new Set([project.path(placement.config), project.path(placement.formats)]));
});

// Unit under test: the loader, given one rule's options while `next dev` runs, across an edit of elmera-intl.json.
// Oracle: Next serializes the rule's options once, at startup, while the loader reads the config afresh for each
// import (#53's dependency); Turbopack hands it the catalog's real path (replayed for #63). So the import compiles under
// the config as it is when the import runs: before the edit, catalogs named through a link inside the root
// (`intl-link -> intl`), and after it the same catalogs named at their target, which the rule's real path still matches.
it("compiles a catalog under the config as edited after withIntl ran", async ({ project }) => {
  const app = project.path("app");
  mkdirSync(project.path("app/intl"), { recursive: true });
  symlinkSync(project.path("app/intl"), project.path("app/intl-link"), "dir");
  mkdirSync(project.path("app/node_modules"), { recursive: true });
  symlinkSync(NEXT, project.path("app/node_modules/next"), "dir");
  const write = (catalogs: string) => {
    project.write("app/elmera-intl.json", JSON.stringify({ include: ["*.ts"], catalogs, locales: ["nb"] }));
  };
  write("intl-link/{locale}.po");
  const wrapped: IntlNextConfig = withIntl(
    { turbopack: { root: app } },
    { dir: app }
  )("phase-development-server");
  // SAFETY: the `*.po` rules withIntl writes (next.ts, poRule); another shape fails the lookup below.
  const rules = new Map(Object.entries(wrapped.turbopack?.rules ?? {})).get("*.po") as ReadonlyArray<{
    readonly loaders: readonly [{ readonly options: PoLoaderOptions }];
  }>;
  const options = rules.map((rule) => rule.loaders[0].options).find((candidate) => !candidate.source);

  if (options === undefined) {
    throw new Error("withIntl wrote no rule for the catalog import");
  }

  const resource = join(realpathSync(app), "intl/nb.po");

  const linked = await load(project, resource, options);
  write("intl/{locale}.po");
  const edited = await load(project, resource, options);

  expect(linked.error).toBeNull();
  expect(edited.error).toBeNull();
});
