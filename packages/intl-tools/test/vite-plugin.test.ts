import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildEnvironmentOptions, InlineConfig, Rolldown, ViteDevServer } from "vite";
import { build, createBuilder, createLogger, createServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import type { OneShotOutcome } from "../src/command-run";
import { runOnceInProcess } from "../src/command-run";
import { intl, intlCatalogs } from "../src/vite";

const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
// A hang guard, not a timing assertion: the dev watcher's sync outlasts poll's 1 s default on a loaded machine.
const HANG_GUARD = { timeout: 10_000 };
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
const PROBE = { ...HANG_GUARD, interval: 500 };

let root = "";
let server: ViteDevServer | undefined;
let watchers: Array<Rolldown.RolldownWatcher> = [];

// A synced, translated project: `<T>Hello</T>` -> "Hei". The entry has no messages; the extractor scans the rest.
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-vite-"));
  write("elmera-intl.json", JSON.stringify(CONFIG));
  write("src/main.ts", "export const answer = 42;\n");
  write("src/page.tsx", component("Hello"));
  await extractAndTranslate();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(watchers.map((watcher) => watcher.close()));
  watchers = [];
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

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

// The project's library build, writing nothing unless `overrides` say so.
function viteConfig(
  options: Parameters<typeof intl>[0] = {},
  overrides: BuildEnvironmentOptions = {}
): InlineConfig {
  return {
    root,
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

// A watch build of `viteConfig` and `extra`, its output under root, each environment on its own watcher. Returns, per
// environment, each build's BUNDLE_START, BUNDLE_END or error message, in order.
async function watchBuild(extra: InlineConfig = {}): Promise<Array<Array<string>>> {
  write("src/main.ts", `export { C } from "./page";\n`);
  const builder = await createBuilder({ ...viteConfig({}, { watch: BUILD_WATCH, write: true }), ...extra });

  return Promise.all(
    Object.values(builder.environments).map(async (environment) => {
      // SAFETY: with build.watch set, an environment's build returns its watcher (the type is the union of every mode).
      const watcher = (await builder.build(environment)) as Rolldown.RolldownWatcher;
      watchers.push(watcher);
      const outcomes: Array<string> = [];
      watcher.on("event", (event) => {
        if (event.code === "BUNDLE_START" || event.code === "BUNDLE_END" || event.code === "ERROR") {
          outcomes.push(event.code === "ERROR" ? event.error.message : event.code);
        }

        if ("result" in event) {
          void event.result.close();
        }
      });

      return outcomes;
    })
  );
}

// `elmera-intl extract` or `check` on the project, silent; how it ended.
async function run(command: "extract" | "check"): Promise<OneShotOutcome> {
  return runOnceInProcess(
    command,
    { configPath: join(root, "elmera-intl.json"), crash: "reject" },
    { stdout: () => undefined, stderr: () => undefined }
  );
}

async function extract(): Promise<void> {
  expect(await run("extract")).toBe("ok");
}

// Syncs the catalogs and translates them: "Hello" is "Hei", and any other message gets `msgstr`.
async function extractAndTranslate(more: ReadonlyArray<readonly [string, string]> = []): Promise<void> {
  await extract();
  let po = read("messages/nb.po");
  for (const [source, translation] of [["Hello", "Hei"], ...more]) {
    po = po.replace(
      `msgid ${JSON.stringify(source)}\nmsgstr ""`,
      `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
    );
  }
  write("messages/nb.po", po);
}

function moneyFormats(currency: string): string {
  return `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`;
}

// A translated message in the `money` style, which the config's formats module defines with `currency`.
async function useMoneyFormats(currency: string): Promise<void> {
  write(
    "src/price.tsx",
    `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
  );
  write("intl-formats.ts", moneyFormats(currency));
  write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
  await extractAndTranslate([["{n, number, money}", "{n, number, money} totalt"]]);
}

// Unit under test: the intl() Vite plugin. Oracle: the check's problem code, the PO text, and the nb render, by hand.
describe("intl() vite plugin", { timeout: 15_000 }, () => {
  it("fails a build whose catalog is out of sync, naming the problem", async () => {
    write("src/new.tsx", component("New"));
    await expect(build(viteConfig())).rejects.toThrow("CatalogOutOfSync");
  });

  it("builds a synced project, and checks the catalogs again when its config is reused", async () => {
    const config = viteConfig();
    await expect(build(config)).resolves.toBeDefined();
    write("src/new.tsx", component("New"));
    await expect(build(config)).rejects.toThrow("CatalogOutOfSync");
  });

  it("checks the catalogs again after a watch rebuild, and rebuilds on a catalog-only repair", async () => {
    const [outcomes = []] = await watchBuild();
    await expect.poll(() => outcomes, HANG_GUARD).toContain("BUNDLE_END");
    write("src/page.tsx", component("Untranslated"));
    await expect.poll(() => outcomes.at(-1), HANG_GUARD).toContain("CatalogOutOfSync");

    // The repair touches only the catalog: extract, then translate.
    await extract();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        `msgid "Untranslated"\nmsgstr ""`,
        `msgid "Untranslated"\nmsgstr "Uoversatt"`
      )
    );
    await expect.poll(() => outcomes.at(-1), HANG_GUARD).toBe("BUNDLE_END");
  });

  // Oracle: Intl rejects the currency "NOKK". The edit touches only the formats module.
  it("checks the catalogs with the edited formats module after a watch rebuild", async () => {
    await useMoneyFormats("NOK");
    const [outcomes = []] = await watchBuild();
    await expect.poll(() => outcomes, HANG_GUARD).toContain("BUNDLE_END");

    write("intl-formats.ts", moneyFormats("NOKK"));
    await expect.poll(() => outcomes.at(-1), HANG_GUARD).toMatch(/Invalid currency code : NOKK/u);
  });

  // The watch covers the project root, where every environment writes its output.
  it.each([
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
  ])("rebuilds $environments when a missing config is created, then stays idle", async ({ extra }) => {
    const config = read("elmera-intl.json");
    rmSync(join(root, "elmera-intl.json"));
    const builds = await watchBuild(extra);
    const last = () => builds.map((outcomes) => outcomes.at(-1));
    await expect
      .poll(() => last().map((outcome) => outcome?.includes("elmera-intl.json")), HANG_GUARD)
      .toEqual(builds.map(() => true));

    write("elmera-intl.json", config);
    await expect.poll(last, HANG_GUARD).toEqual(builds.map(() => "BUNDLE_END"));
    // Rolldown 1.2 runs the repaired build twice back to back, and the first's end looks like the second's, so the
    // idle window starts once the second has had time to land.
    await new Promise((resolve) => {
      // oxlint-disable-next-line tests/no-fixed-delay -- Settle: Rolldown's back-to-back second build lands within 1 s and has no distinct event to await.
      setTimeout(resolve, 1000);
    });
    const built = builds.map((outcomes) => outcomes.length);
    // A rebuild loop restarts within milliseconds of each written bundle.
    await new Promise((resolve) => {
      // oxlint-disable-next-line tests/no-fixed-delay -- Absence check: no rebuild may start within 1 s of the repaired builds, and an absence has no event to await.
      setTimeout(resolve, 1000);
    });
    expect(builds.map((outcomes, index) => outcomes.slice(built[index]))).toEqual(builds.map(() => []));
  });

  // Each removal returns a repair that writes only what is missing, so only a watch on it (or an ancestor) rebuilds.
  it.each([
    {
      missing: "the catalog directory",
      remove: () => {
        rmSync(join(root, "messages"), { recursive: true });

        return extractAndTranslate;
      },
    },
    {
      // Restored as is (a checkout, say).
      missing: "a locale's PO",
      remove: () => {
        const po = read("messages/nb.po");
        rmSync(join(root, "messages/nb.po"));

        return () => {
          write("messages/nb.po", po);
        };
      },
    },
  ])("rebuilds when $missing is created", async ({ remove }) => {
    const repair = remove();
    const [outcomes = []] = await watchBuild();
    await expect.poll(() => outcomes.at(-1), HANG_GUARD).toContain("elmera-intl check failed");

    await repair();
    await expect.poll(() => outcomes.at(-1), HANG_GUARD).toBe("BUNDLE_END");
  });

  // Oracle: Intl rejects the currency "NOKK". A dev server's PO load re-runs on the formats module's save.
  it("loads a catalog with the edited formats module during dev", async () => {
    await useMoneyFormats("NOK");
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: SERVER_WATCH,
      plugins: [intl()],
    });
    const load = async () => {
      try {
        await server?.ssrLoadModule("/messages/nb.po");

        return "loaded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    await expect(load()).resolves.toBe("loaded");

    write("intl-formats.ts", moneyFormats("NOKK"));
    await expect.poll(load, HANG_GUARD).toMatch(/Invalid currency code : NOKK/u);
  });

  it("adds a message written during dev to the PO", async () => {
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: SERVER_WATCH,
      plugins: [intl()],
    });
    // fs.watch has no ready signal, and a recursive watch misses an edit made before its stream starts (seen under
    // load). A probe is rewritten until a sync shows the watch is live, so the edit under test lands on a live watch.
    await expect
      .poll(() => {
        write("src/ready.tsx", component("Ready"));

        return read("messages/nb.po");
      }, PROBE)
      .toContain(`msgid "Ready"`);
    write("src/new.tsx", component("New"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "New"\nmsgstr ""`);
  });

  // Unit under test: the dev plugin's watch, as a dev server starts and closes it. Oracle: layer 2's plugin, by hand:
  // closing the dev server closes the watch, so every file watcher it opened is closed. A close during the watch's start
  // is the hook-level test below.
  it("closes its watch when the dev server closes", async () => {
    const before = watches();
    // A message the first sync adds, so the watch has started once the server has.
    write("src/first.tsx", component("First"));
    const dev = await createServer({ root, configFile: false, logLevel: "silent", plugins: [intl()] });
    server = dev;
    await dev.close();

    expect(read("messages/nb.po")).toContain(`msgid "First"`);
    await expect.poll(watches, HANG_GUARD).toBe(before);
  });

  // Unit under test: the dev plugin's own hooks, called in the order Vite calls them when a dev server closes while the
  // watch is still starting: `configureServer`, not yet settled, then `closeBundle`. Oracle: layer 2's plugin, by hand:
  // the close closes the watch, whatever point its start has reached, so no watcher stays open once both settle.
  it("closes a watch whose start is still pending when the bundle closes", async () => {
    const before = watches();
    // A message the first sync adds, so the watch has started once its start settles.
    write("src/first.tsx", component("First"));
    // A real dev server, for the config the plugin reads; the plugin's hooks are called below, as Vite would.
    const dev = await createServer({ root, configFile: false, logLevel: "silent", plugins: [] });
    server = dev;
    const watch = intl().find((plugin) => plugin.name === "elmera-intl:watch");
    const configureServer = handlerOf(watch?.configureServer);
    const closeBundle = handlerOf(watch?.closeBundle);
    expect([configureServer, closeBundle].map((hook) => hook === undefined)).toEqual([false, false]);

    const starting = configureServer?.call(HOOK_CONTEXT, dev);
    await closeBundle?.call(HOOK_CONTEXT);
    await starting;
    await dev.close();

    expect(read("messages/nb.po")).toContain(`msgid "First"`);
    await expect.poll(watches, HANG_GUARD).toBe(before);
  });

  // Oracle: the poll interval contract (10 ms to Node's timer maximum): the dev server's interval feeds the same
  // poller as `--poll`, so one out of range is reported, and the watch polls at the default instead.
  it("reports a dev server poll interval out of range and polls at the default", async () => {
    const errors: Array<string> = [];
    server = await createServer({
      root,
      configFile: false,
      customLogger: {
        ...createLogger("silent"),
        error: (message) => {
          errors.push(message);
        },
      },
      server: { watch: { usePolling: true, interval: 1 } },
      plugins: [intl()],
    });
    write("src/new.tsx", component("New"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "New"\nmsgstr ""`);

    expect(errors).toEqual([expect.stringContaining("server.watch.interval 1 is outside 10 to 2147483647")]);
  });
});

// The project's library build of an entry that imports catalogs, through `plugins`: the bundle's exports by name.
async function buildCatalogs(
  entry: string,
  plugins = [intlCatalogs()]
): Promise<ReadonlyMap<string, unknown>> {
  write("src/main.ts", entry);
  const output = await build({ ...viteConfig(), plugins });
  const [first] = [output].flat();
  const chunk =
    first !== undefined && "output" in first ? first.output.find((file) => file.type === "chunk") : undefined;

  if (chunk?.type !== "chunk") {
    throw new Error("no chunk");
  }

  write("out.mjs", chunk.code);
  const loaded: unknown = await import(
    /* @vite-ignore */ `${pathToFileURL(join(root, "out.mjs")).href}?${Date.now()}`
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

// Unit under test: the `*.po` load hook (alone, as a Vitest config uses it). Oracle: the hand-written rendering of each
// locale through the runtime, Intl's nb and en number formats.
describe("intlCatalogs()", { timeout: 15_000 }, () => {
  const COUNT = "{n, number} items";

  beforeEach(async () => {
    write(
      "src/count.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const COUNT = msg(${JSON.stringify(COUNT)});\n`
    );
    await extractAndTranslate([[COUNT, "{n, number} varer"]]);
  });

  it("compiles a PO import to its locale's catalog, and ?source to the English one", async () => {
    const exports = await buildCatalogs(
      `import nb from "../messages/nb.po";\nimport en from "../messages/nb.po?source";\nexport { nb, en };\n`
    );
    const nb = catalogExport(exports, "nb");
    const en = catalogExport(exports, "en");
    const render = (locale: string, catalog: Catalog) => createIntl({ locale, catalog, timeZone: "UTC" });

    expect([render("nb", nb).t(COUNT, { n: 1234.5 }), render("nb", nb).t("Hello")]).toEqual([
      "1\u00A0234,5 varer",
      "Hei",
    ]);
    expect(render("en", en).t(COUNT, { n: 1234.5 })).toBe("1,234.5 items");
  });

  it("fails the import of a catalog that does not compile, naming the entry", async () => {
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        'msgstr "{n, number} varer"',
        'msgstr "{n, number, ::currency/NOKK} varer"'
      )
    );

    await expect(buildCatalogs(`export { default } from "../messages/nb.po";\n`)).rejects.toThrow(
      /\[node\] "\{n, number\} items": .*NOKK/u
    );
  });

  // Oracle: Intl rejects the currency "NOKK"; the style is invalid only through the formats module the config names.
  it("compiles with the config's formats module", async () => {
    write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
    );
    await extractAndTranslate([["{n, number, money}", "{n, number, money} totalt"]]);
    write(
      "intl-formats.ts",
      `export const formats = { number: { money: { style: "currency", currency: "NOKK" } } };\n`
    );
    const entry = `export { default } from "../messages/nb.po";\n`;
    await expect(buildCatalogs(entry)).resolves.toBeDefined();

    write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
    await expect(buildCatalogs(entry)).rejects.toThrow(
      /"\{n, number, money\}": Invalid currency code : NOKK/u
    );
  });

  it("fails the import of a PO of no configured locale", async () => {
    write("messages/sv.po", read("messages/nb.po"));

    await expect(buildCatalogs(`export { default } from "../messages/sv.po";\n`)).rejects.toThrow(
      "messages/sv.po is not a configured catalog"
    );
  });

  it("fails the import of a configured locale's missing PO", async () => {
    rmSync(join(root, "messages/nb.po"));

    await expect(buildCatalogs(`export { default } from "../messages/nb.po";\n`)).rejects.toThrow("nb.po");
  });
});

// Unit under test: include/exclude membership across extract and check. Oracle: the bare-pattern
// project above, which extracts and checks; a `./` spelling of the same patterns must behave identically.
describe("./-prefixed patterns", { timeout: 15_000 }, () => {
  beforeEach(() => {
    write(
      "elmera-intl.json",
      JSON.stringify({ ...CONFIG, include: ["./src/**/*.{ts,tsx}"], exclude: ["./src/skip/**"] })
    );
    write("src/skip/draft.tsx", component("Draft"));
  });

  it("extracts and checks the included files, skipping the excluded ones", async () => {
    expect([await run("extract"), await run("check")]).toEqual(["ok", "ok"]);
    expect(read("messages/nb.po")).not.toContain("Draft");
  });
});

// Unit under test: directory excludes across extract and check. Oracle: globSync's exclude, which
// prunes a matched directory, so nothing under it is a project source.
describe.each([
  { include: ["src/**/*.{ts,tsx}"], exclude: ["src/skip"] },
  { include: ["./src/**/*.{ts,tsx}"], exclude: ["./src/skip/"] },
])("excluded directory $exclude", { timeout: 15_000 }, (patterns) => {
  beforeEach(() => {
    write("elmera-intl.json", JSON.stringify({ ...CONFIG, ...patterns }));
    write("src/skip/draft.tsx", component("Draft"));
  });

  it("extracts and checks without the directory's files", async () => {
    expect([await run("extract"), await run("check")]).toEqual(["ok", "ok"]);
    expect(read("messages/nb.po")).not.toContain("Draft");
  });
});
