import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildEnvironmentOptions, InlineConfig, Rolldown, ViteDevServer } from "vite";
import { build, createBuilder, createLogger, createServer } from "vite";
import { describe, expect, test } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import type { OneShotOutcome } from "../src/command-run";
import { runOnceInProcess } from "../src/command-run";
import { intl, intlCatalogs } from "../src/vite";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
// Every watcher here polls (Rolldown's build watcher and the dev server's, which the plugin's extract watch follows),
// so a wait ends on the edit, not on the host's file-event daemon (fseventsd on macOS delays or drops events under
// load). Polling is the same setting an app on such a host uses; the default native events run in the e2e dev loop.
const POLL_MS = 50;
// Vite 8.3 builds Rolldown's watcher from `build.watch.chokidar`, which its types no longer declare, and replaces the
// typed `build.watch.watcher` with it; both are set so the build polls whichever Vite reads.
const BUILD_WATCH = {
  watcher: { usePolling: true, pollInterval: POLL_MS },
  chokidar: { usePolling: true, interval: POLL_MS },
};
const SERVER_WATCH = { watch: { usePolling: true, interval: POLL_MS } };
// Probe writes spaced past the watch's 100 ms debounce, so a rewrite does not postpone the sync it waits for.
const PROBE_INTERVAL_MS = 500;

// Each test owns its project (see `Project`), synced and translated: `<T>Hello</T>` -> "Hei"; the entry has no
// messages, the extractor scans the rest. Every helper takes the project, so a test that overruns cannot touch the next
// test's files, and every wait ends by the project's deadline. What a test starts (a dev server, a watch build) it
// closes through `project.defer`, before the root is removed.
const it = test.extend("project", async ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-vite-", task.timeout);
  onCleanup(close);
  project.write("elmera-intl.json", JSON.stringify(CONFIG));
  project.write("src/main.ts", "export const answer = 42;\n");
  project.write("src/page.tsx", component("Hello"));
  await extractAndTranslate(project);

  return project;
});

function component(text: string): string {
  return `import { T } from "@elmeragroup/intl/react";\nexport const C = () => <T>${text}</T>;\n`;
}

// The file watchers open in this process.
function watches(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap").length;
}

// The two hooks called here return nothing, or (configureServer) a function Vite calls after its middlewares.
type HookResult = void | (() => void) | Promise<void | (() => void)>;

// A plugin hook's function, whether the plugin gave it bare or as `{ handler }`.
function handlerOf<F extends (...args: never) => HookResult>(
  hook: F | { readonly handler: F } | undefined
): F | undefined {
  return hook === undefined || !("handler" in hook) ? hook : hook.handler;
}

// SAFETY: the dev plugin's hooks never read `this`; Vite's context for them is not needed to call them as Vite does.
const HOOK_CONTEXT = {} as Rolldown.PluginContext;
// SAFETY: the check's buildStart reads no build options; Rolldown's normalized options are not constructible here.
const BUILD_OPTIONS = {} as Rolldown.NormalizedInputOptions;

// The project's library build, writing nothing unless `overrides` say so.
function viteConfig(
  project: Project,
  options: Parameters<typeof intl>[0] = {},
  overrides: BuildEnvironmentOptions = {}
): InlineConfig {
  return {
    root: project.root,
    configFile: false,
    logLevel: "silent",
    plugins: [intl(options)],
    build: {
      write: false,
      lib: { entry: "src/main.ts", formats: ["es"] },
      // The temp project has no node_modules to resolve the runtime from.
      rolldownOptions: { external: [/^@elmeragroup\/intl/u, /^react/u] },
      ...overrides,
    },
  };
}

/** One environment's watch build, as its watcher reports it. */
type WatchLog = {
  /** Each build's BUNDLE_START, BUNDLE_END or error message, in order. */
  readonly outcomes: Array<string>;
  /** Each change the watcher reported, as its path under the root, in order. */
  readonly changes: Array<string>;
  /** Whether the watcher's last event is END: its run, every bundle of it, has finished. */
  readonly settled: () => boolean;
};

// A watch build of `viteConfig` and `extra`, its output under root, each environment on its own watcher, closed when
// the test ends.
async function watchBuild(project: Project, extra: InlineConfig = {}): Promise<Array<WatchLog>> {
  project.write("src/main.ts", `export { C } from "./page";\n`);
  const builder = await createBuilder({
    ...viteConfig(project, {}, { watch: BUILD_WATCH, write: true }),
    ...extra,
  });

  return Promise.all(
    Object.values(builder.environments).map(async (environment) => {
      // SAFETY: with build.watch set, an environment's build returns its watcher (the type is the union of every mode).
      const watcher = (await builder.build(environment)) as Rolldown.RolldownWatcher;
      project.defer(() => watcher.close());
      const outcomes: Array<string> = [];
      const changes: Array<string> = [];
      let last = "";
      // The watcher reports realpaths.
      const root = realpathSync(project.root);
      watcher.on("change", (id) => {
        changes.push(relative(root, id));
      });
      watcher.on("event", (event) => {
        last = event.code;

        if (event.code === "BUNDLE_START" || event.code === "BUNDLE_END" || event.code === "ERROR") {
          outcomes.push(event.code === "ERROR" ? event.error.message : event.code);
        }

        if ("result" in event) {
          void event.result.close();
        }
      });

      return { outcomes, changes, settled: () => last === "END" };
    })
  );
}

// `elmera-intl extract` or `check` on the project, silent; how it ended.
async function run(project: Project, command: "extract" | "check"): Promise<OneShotOutcome> {
  return runOnceInProcess(
    command,
    { configPath: project.path("elmera-intl.json"), crash: "reject" },
    { stdout: () => undefined, stderr: () => undefined }
  );
}

async function extract(project: Project): Promise<void> {
  expect(await run(project, "extract")).toBe("ok");
}

// Syncs the catalogs and translates them: "Hello" is "Hei", and any other message gets `msgstr`.
async function extractAndTranslate(
  project: Project,
  more: ReadonlyArray<readonly [string, string]> = []
): Promise<void> {
  await extract(project);
  let po = project.read("messages/nb.po");
  for (const [source, translation] of [["Hello", "Hei"], ...more]) {
    po = po.replace(
      `msgid ${JSON.stringify(source)}\nmsgstr ""`,
      `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
    );
  }
  project.write("messages/nb.po", po);
}

function moneyFormats(currency: string): string {
  return `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`;
}

// A translated message in the `money` style, which the config's formats module defines with `currency`.
async function useMoneyFormats(project: Project, currency: string): Promise<void> {
  project.write(
    "src/price.tsx",
    `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
  );
  project.write("intl-formats.ts", moneyFormats(currency));
  project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
  await extractAndTranslate(project, [["{n, number, money}", "{n, number, money} totalt"]]);
}

// A dev server on the project, closed when the test ends.
async function devServer(project: Project, config: InlineConfig): Promise<ViteDevServer> {
  const server = await createServer({ root: project.root, configFile: false, logLevel: "silent", ...config });
  project.defer(() => server.close());

  return server;
}

// The plugin's own hooks, to call them as Vite does.
function hooksOf(name: "elmera-intl:watch" | "elmera-intl:check") {
  const plugin = intl().find((candidate) => candidate.name === name);
  const hooks = {
    configureServer: handlerOf(plugin?.configureServer),
    buildStart: handlerOf(plugin?.buildStart),
    closeBundle: handlerOf(plugin?.closeBundle),
  };

  return hooks;
}

// Writes `text` to `file` (relative to the root, under every watcher's watch), again each probe interval, until each
// watcher reports it. Rolldown registers a run's watch files after the run, with no event for it, and never reports a
// change made before then: under load, 9 of 20 configs created after a run's END were never reported (the probe in
// `.ref`), and one created just after another reported change was missed by the rebuild that change started. A
// rewrite after the registration is reported, whatever the timing.
async function untilReported(
  project: Project,
  builds: ReadonlyArray<WatchLog>,
  file: string,
  text: string
): Promise<void> {
  await expect
    .poll(
      () => {
        project.write(file, text);

        return builds.map(({ changes }) => changes.includes(file));
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toEqual(builds.map(() => true));
}

// Unit under test: the intl() Vite plugin. Oracle: the check's problem code, the PO text, and the nb render, by hand.
describe("intl() vite plugin", { timeout: 15_000 }, () => {
  it("fails a build whose catalog is out of sync, naming the problem", async ({ project }) => {
    project.write("src/new.tsx", component("New"));
    await expect(build(viteConfig(project))).rejects.toThrow("CatalogOutOfSync");
  });

  // Oracle: the layer 2 plugin, by hand: a check that crashes fails the build with the crash itself, not a problem
  // report. A directory where the nb catalog goes makes check's read throw EISDIR, which it does not classify.
  it("fails a build whose check crashes, with the crash", async ({ project }) => {
    rmSync(project.path("messages/nb.po"));
    mkdirSync(project.path("messages/nb.po"));
    await expect(build(viteConfig(project))).rejects.toThrow(/EISDIR/u);
  });

  it("builds a synced project, and checks the catalogs again when its config is reused", async ({
    project,
  }) => {
    const config = viteConfig(project);
    await expect(build(config)).resolves.toBeDefined();
    project.write("src/new.tsx", component("New"));
    await expect(build(config)).rejects.toThrow("CatalogOutOfSync");
  });

  it("checks the catalogs again after a watch rebuild, and rebuilds on a catalog-only repair", async ({
    project,
  }) => {
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes, project.guard()).toContain("BUNDLE_END");
    project.write("src/page.tsx", component("Untranslated"));
    await expect.poll(() => outcomes.at(-1), project.guard()).toContain("CatalogOutOfSync");

    // The repair touches only the catalog: extract, then translate.
    await extract(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(`msgid "Untranslated"\nmsgstr ""`, `msgid "Untranslated"\nmsgstr "Uoversatt"`)
    );
    await expect.poll(() => outcomes.at(-1), project.guard()).toBe("BUNDLE_END");
  });

  // Oracle: Intl rejects the currency "NOKK". The edit touches only the formats module.
  it("checks the catalogs with the edited formats module after a watch rebuild", async ({ project }) => {
    await useMoneyFormats(project, "NOK");
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes, project.guard()).toContain("BUNDLE_END");

    project.write("intl-formats.ts", moneyFormats("NOKK"));
    await expect.poll(() => outcomes.at(-1), project.guard()).toMatch(/Invalid currency code : NOKK/u);
  });

  // Unit under test: the build plugin's exclude of every environment's output from its watch. Oracle: Rolldown's poll
  // watcher reports each change it sees, and a change it reports starts a rebuild: a watch that covers an output
  // reports that output's write, and rebuilds on it, in a loop. The watch covers the project root, where every
  // environment writes its output (the config is missing, so its nearest existing ancestor is watched).
  it.for([
    { environments: "one environment", extra: {} },
    {
      environments: "client and SSR",
      // Each environment its own watch options (as when set per environment), so neither inherits the other's
      // exclude through a shared object.
      extra: {
        builder: {},
        environments: {
          client: { build: { outDir: "dist/client", watch: BUILD_WATCH } },
          ssr: { build: { outDir: "dist/server", watch: BUILD_WATCH } },
        },
      },
    },
  ])(
    "rebuilds $environments when a missing config is created, then stays idle",
    async ({ extra }, { project }) => {
      const config = project.read("elmera-intl.json");
      rmSync(project.path("elmera-intl.json"));
      const builds = await watchBuild(project, extra);
      const last = () => builds.map(({ outcomes }) => outcomes.at(-1));
      await expect
        .poll(() => last().map((outcome) => outcome?.includes("elmera-intl.json")), project.guard())
        .toEqual(builds.map(() => true));

      // Created, then rewritten until each watcher reports it: the root's watch (its nearest existing ancestor) is
      // the only one that can see it, so a report means the plugin watched the ancestor.
      await untilReported(project, builds, "elmera-intl.json", config);
      await expect
        .poll(() => builds.map(({ outcomes, settled }) => [outcomes.at(-1), settled()]), project.guard())
        .toEqual(builds.map(() => ["BUNDLE_END", true]));

      // Idle: the repaired build's outputs are written before the entry below is touched, and a poll watcher reports
      // every change it has seen by the time it reports a later one, so once each watcher has reported the touch, any
      // output it reports would be among the changes. Every one is the config or the touch.
      await untilReported(project, builds, "src/main.ts", project.read("src/main.ts"));
      expect(
        builds.map(({ changes }) =>
          changes.filter((change) => !/^(?:elmera-intl\.json|src\/main\.ts)$/u.test(change))
        )
      ).toEqual(builds.map(() => []));
    }
  );

  // Each removal returns a repair that writes only what is missing, so only a watch on it (or an ancestor) rebuilds.
  it.for([
    {
      missing: "the catalog directory",
      remove: (project: Project) => {
        rmSync(project.path("messages"), { recursive: true });

        return () => extractAndTranslate(project);
      },
    },
    {
      // Restored as is (a checkout, say).
      missing: "a locale's PO",
      remove: (project: Project) => {
        const po = project.read("messages/nb.po");
        rmSync(project.path("messages/nb.po"));

        return () => {
          project.write("messages/nb.po", po);

          return Promise.resolve();
        };
      },
    },
  ])("rebuilds when $missing is created", async ({ remove }, { project }) => {
    const repair = remove(project);
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes.at(-1), project.guard()).toContain("elmera-intl check failed");

    await repair();
    await expect.poll(() => outcomes.at(-1), project.guard()).toBe("BUNDLE_END");
  });

  // Oracle: Intl rejects the currency "NOKK". A dev server's PO load re-runs on the formats module's save.
  it("loads a catalog with the edited formats module during dev", async ({ project }) => {
    await useMoneyFormats(project, "NOK");
    const server = await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });
    const load = async () => {
      try {
        await server.ssrLoadModule("/messages/nb.po");

        return "loaded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    await expect(load()).resolves.toBe("loaded");

    project.write("intl-formats.ts", moneyFormats("NOKK"));
    await expect.poll(load, project.guard()).toMatch(/Invalid currency code : NOKK/u);
  });

  it("adds a message written during dev to the PO", async ({ project }) => {
    await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });
    // fs.watch has no ready signal, and a recursive watch misses an edit made before its stream starts (seen under
    // load). A probe is rewritten until a sync shows the watch is live, so the edit under test lands on a live watch.
    await expect
      .poll(
        () => {
          project.write("src/ready.tsx", component("Ready"));

          return project.read("messages/nb.po");
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toContain(`msgid "Ready"`);
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`msgid "New"\nmsgstr ""`);
  });

  // Unit under test: the dev plugin's watch, as a dev server starts and closes it. Oracle: layer 2's plugin, by hand:
  // closing the dev server closes the watch, so every file watcher it opened is closed. A close during the watch's start
  // is the hook-level test below.
  it("closes its watch when the dev server closes", async ({ project }) => {
    const before = watches();
    // A message the first sync adds, so the watch has started once the server has.
    project.write("src/first.tsx", component("First"));
    const server = await devServer(project, { plugins: [intl()] });
    await server.close();

    expect(project.read("messages/nb.po")).toContain(`msgid "First"`);
    await expect.poll(watches, project.guard()).toBe(before);
  });

  // Unit under test: the dev plugin's own hooks, called in the order Vite calls them when a dev server closes while the
  // watch is still starting: `configureServer`, not yet settled, then `closeBundle`, once per environment and in
  // parallel. Oracle: layer 2's plugin, by hand: the close closes the watch once its start has settled, whatever point
  // the start has reached, so its first sync is written and no watcher stays open once every hook settles. Each close
  // is safe, the second included: it waits for the first's stop and finds the runtime already going.
  it.for([1, 2])(
    "closes a watch whose start is still pending when %i environment(s) close the bundle",
    async (closes, { project }) => {
      const before = watches();
      // A message the first sync adds, so the watch has started once its start settles.
      project.write("src/first.tsx", component("First"));
      // A real dev server, for the config the plugin reads; the plugin's hooks are called below, as Vite would. Its own
      // file watcher is off: on Linux it opens a handle per directory and file shortly after the server starts, and
      // keeps them until teardown, so only the plugin's watchers are counted.
      const server = await devServer(project, { plugins: [], server: { watch: null } });
      const { configureServer, closeBundle } = hooksOf("elmera-intl:watch");
      expect([configureServer, closeBundle].map((hook) => hook === undefined)).toEqual([false, false]);

      const starting = configureServer?.call(HOOK_CONTEXT, server);
      await project.within(
        Promise.all(Array.from({ length: closes }, () => Promise.resolve(closeBundle?.call(HOOK_CONTEXT)))),
        "the closes"
      );
      await project.within(Promise.resolve(starting), "the start");

      expect(project.read("messages/nb.po")).toContain(`msgid "First"`);
      await expect.poll(watches, project.guard()).toBe(before);
    }
  );

  // Unit under test: the build plugin's own hooks, called as a build of two environments calls them in parallel: both
  // environments' `closeBundle` while a `buildStart` check is under way. Oracle: the check's contract, by hand: a
  // synced project passes, and a build after both ends checks again on a fresh runtime (an out-of-sync catalog fails it
  // with its problem).
  it("passes a check its environments' closes race, then checks again", async ({ project }) => {
    const { buildStart, closeBundle } = hooksOf("elmera-intl:check");
    const context = {
      meta: { watchMode: false },
      environment: { config: { root: project.root } },
      addWatchFile: () => undefined,
      error: (message: string) => {
        throw new Error(message);
      },
    };
    // SAFETY: the check plugin's hooks read only the build's watch mode, the environment's root, addWatchFile and
    // error, which this has.
    const call = <A extends ReadonlyArray<unknown>, R>(hook: ((...args: A) => R) | undefined, ...args: A) =>
      Promise.resolve(hook?.call(context as never, ...args));

    const checking = call(buildStart, BUILD_OPTIONS);
    const closing = Promise.all([call(closeBundle), call(closeBundle)]);
    await expect(project.within(checking, "the running check")).resolves.toBeUndefined();
    await project.within(closing, "the closes");

    project.write("src/new.tsx", component("New"));
    await expect(project.within(call(buildStart, BUILD_OPTIONS), "the next check")).rejects.toThrow(
      "CatalogOutOfSync"
    );
  });

  // Oracle: the poll interval contract (10 ms to Node's timer maximum): the dev server's interval feeds the same
  // poller as `--poll`, so one out of range is reported, and the watch polls at the default instead.
  it("reports a dev server poll interval out of range and polls at the default", async ({ project }) => {
    const errors: Array<string> = [];
    await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        error: (message) => {
          errors.push(message);
        },
      },
      server: { watch: { usePolling: true, interval: 1 } },
      plugins: [intl()],
    });
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`msgid "New"\nmsgstr ""`);

    expect(errors).toEqual([expect.stringContaining("server.watch.interval 1 is outside 10 to 2147483647")]);
  });
});

// The project's library build of an entry that imports catalogs, through `plugins`: the bundle's exports by name.
async function buildCatalogs(
  project: Project,
  entry: string,
  plugins = [intlCatalogs()]
): Promise<ReadonlyMap<string, unknown>> {
  project.write("src/main.ts", entry);
  const output = await build({ ...viteConfig(project), plugins });
  const [first] = [output].flat();
  const chunk =
    first !== undefined && "output" in first ? first.output.find((file) => file.type === "chunk") : undefined;

  if (chunk?.type !== "chunk") {
    throw new Error("no chunk");
  }

  project.write("out.mjs", chunk.code);
  const loaded: unknown = await import(
    /* @vite-ignore */ `${pathToFileURL(project.path("out.mjs")).href}?${Date.now()}`
  );

  // A module namespace has a null prototype, so Object() boxes nothing.
  return new Map(Object.entries(new Object(loaded)));
}

// A bundle export the test built from a PO import, as the runtime gets it.
function catalogExport(exports: ReadonlyMap<string, unknown>, name: string): Catalog {
  // SAFETY: the export is a catalog module's default, compiled by the plugin under test; a wrong value fails the
  // renders that read it.
  return exports.get(name) as Catalog;
}

const COUNT = "{n, number} items";

// A counted message, translated.
async function useCount(project: Project): Promise<void> {
  project.write(
    "src/count.tsx",
    `import { msg } from "@elmeragroup/intl/react";\nexport const COUNT = msg(${JSON.stringify(COUNT)});\n`
  );
  await extractAndTranslate(project, [[COUNT, "{n, number} varer"]]);
}

// Unit under test: the `*.po` load hook (alone, as a Vitest config uses it). Oracle: the hand-written rendering of each
// locale through the runtime, Intl's nb and en number formats.
describe("intlCatalogs()", { timeout: 15_000 }, () => {
  it("compiles a PO import to its locale's catalog, and ?source to the English one", async ({ project }) => {
    await useCount(project);
    const exports = await buildCatalogs(
      project,
      `import nb from "../messages/nb.po";\nimport en from "../messages/nb.po?source";\nexport { nb, en };\n`
    );
    const nb = catalogExport(exports, "nb");
    const en = catalogExport(exports, "en");
    const render = (locale: string, catalog: Catalog) => createIntl({ locale, catalog, timeZone: "UTC" });

    expect([render("nb", nb).t(COUNT, { n: 1234.5 }), render("nb", nb).t("Hello")]).toEqual([
      "1 234,5 varer",
      "Hei",
    ]);
    expect(render("en", en).t(COUNT, { n: 1234.5 })).toBe("1,234.5 items");
  });

  it("fails the import of a catalog that does not compile, naming the entry", async ({ project }) => {
    await useCount(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace('msgstr "{n, number} varer"', 'msgstr "{n, number, ::currency/NOKK} varer"')
    );

    await expect(buildCatalogs(project, `export { default } from "../messages/nb.po";\n`)).rejects.toThrow(
      /\[node\] "\{n, number\} items": .*NOKK/u
    );
  });

  // Oracle: Intl rejects the currency "NOKK"; the style is invalid only through the formats module the config names.
  it("compiles with the config's formats module", async ({ project }) => {
    await useCount(project);
    project.write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
    );
    await extractAndTranslate(project, [["{n, number, money}", "{n, number, money} totalt"]]);
    project.write(
      "intl-formats.ts",
      `export const formats = { number: { money: { style: "currency", currency: "NOKK" } } };\n`
    );
    const entry = `export { default } from "../messages/nb.po";\n`;
    await expect(buildCatalogs(project, entry)).resolves.toBeDefined();

    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
    await expect(buildCatalogs(project, entry)).rejects.toThrow(
      /"\{n, number, money\}": Invalid currency code : NOKK/u
    );
  });

  it("fails the import of a PO of no configured locale", async ({ project }) => {
    await useCount(project);
    project.write("messages/sv.po", project.read("messages/nb.po"));

    await expect(buildCatalogs(project, `export { default } from "../messages/sv.po";\n`)).rejects.toThrow(
      "messages/sv.po is not a configured catalog"
    );
  });

  it("fails the import of a configured locale's missing PO", async ({ project }) => {
    await useCount(project);
    rmSync(project.path("messages/nb.po"));

    await expect(buildCatalogs(project, `export { default } from "../messages/nb.po";\n`)).rejects.toThrow(
      "nb.po"
    );
  });
});

// Unit under test: include/exclude membership across extract and check. Oracle: the bare-pattern
// project above, which extracts and checks; a `./` spelling of the same patterns must behave identically.
describe("./-prefixed patterns", { timeout: 15_000 }, () => {
  it("extracts and checks the included files, skipping the excluded ones", async ({ project }) => {
    project.write(
      "elmera-intl.json",
      JSON.stringify({ ...CONFIG, include: ["./src/**/*.{ts,tsx}"], exclude: ["./src/skip/**"] })
    );
    project.write("src/skip/draft.tsx", component("Draft"));

    expect([await run(project, "extract"), await run(project, "check")]).toEqual(["ok", "ok"]);
    expect(project.read("messages/nb.po")).not.toContain("Draft");
  });
});

// Unit under test: directory excludes across extract and check. Oracle: globSync's exclude, which
// prunes a matched directory, so nothing under it is a project source.
describe.each([
  { include: ["src/**/*.{ts,tsx}"], exclude: ["src/skip"] },
  { include: ["./src/**/*.{ts,tsx}"], exclude: ["./src/skip/"] },
])("excluded directory $exclude", { timeout: 15_000 }, (patterns) => {
  it("extracts and checks without the directory's files", async ({ project }) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, ...patterns }));
    project.write("src/skip/draft.tsx", component("Draft"));

    expect([await run(project, "extract"), await run(project, "check")]).toEqual(["ok", "ok"]);
    expect(project.read("messages/nb.po")).not.toContain("Draft");
  });
});
