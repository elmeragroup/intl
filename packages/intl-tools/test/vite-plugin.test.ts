import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InlineConfig, Rolldown, ViteDevServer } from "vite";
import { build, createBuilder, createLogger, createServer } from "vite";
import { describe, expect } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import type { ProjectServices } from "../src/project-services";
import { intl, intlCatalogs } from "../src/vite";
import { intlPlugins } from "../src/vite-plugins";
import type { WatchServices } from "../src/watch";
import { CatalogSync } from "../src/watch";
import type { Project } from "./project-fixture";
import type { DevEdit } from "./vite-project";
import {
  applyEdit,
  BUILD_WATCH,
  CHOKIDAR_VARIABLES,
  component,
  CONFIG,
  countedServices,
  devServer,
  extractAndTranslate,
  it,
  moneyFormats,
  outsideRoot,
  PROBE_INTERVAL_MS,
  run,
  SERVER_WATCH,
  switchFormats,
  untilSynced,
  useMoneyFormats,
  viteConfig,
} from "./vite-project";
import type { DeliveredEvents } from "./watch-project";
import { deliveredEvents, syncCatalogServices } from "./watch-project";

// The built executable, as an app runs it.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));

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

// The context Vite gives the dev plugin's closeBundle, which reads only the dev server its environment belongs to.
function devContext(server: ViteDevServer): Rolldown.PluginContext {
  // SAFETY: the dev plugin's hooks read only `this.environment.getTopLevelConfig()`, which this answers as the server's
  // environments do; configureServer reads no `this`.
  return { environment: { getTopLevelConfig: () => server.config } } as never;
}
// SAFETY: the check's buildStart reads no build options; Rolldown's normalized options are not constructible here.
const BUILD_OPTIONS = {} as Rolldown.NormalizedInputOptions;

// The plugin's own hooks, to call them as Vite does.
function hooksOf(name: "elmera-intl:watch" | "elmera-intl:check") {
  const plugin = intl().find((candidate) => candidate.name === name);

  return {
    configureServer: handlerOf(plugin?.configureServer),
    buildStart: handlerOf(plugin?.buildStart),
    closeBundle: handlerOf(plugin?.closeBundle),
  };
}

// The chokidar variables a dev server is made under, each unset when absent (the project's `it` unsets them all).
type ChokidarEnv = { readonly [Name in (typeof CHOKIDAR_VARIABLES)[number]]?: string };

// A dev server of `intl()` made under `env`, its sessions on `services` (the real ones, with `events` for the platform's
// file events), whose watch hears no platform file event: each tree's listener is recorded and never called, so only a
// watch that polls syncs a save.
async function unheardServer(
  project: Project,
  env: ChokidarEnv,
  config: InlineConfig,
  events: DeliveredEvents = deliveredEvents(),
  services: Layer.Layer<WatchServices | ProjectServices> = countedServices(CatalogSync.layer(), events.layer)
    .layer
): Promise<DeliveredEvents> {
  CHOKIDAR_VARIABLES.forEach((name) => {
    const value = env[name];

    if (value !== undefined) {
      process.env[name] = value;
    }
  });
  await devServer(project, { ...config, plugins: intlPlugins({}, services) });

  return events;
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

  // Unit under test: `intl()`'s dev server, loading a PO import before and after one edit. Oracle: Intl rejects the
  // currency "NOKK", which only the edit makes reachable: a PO load re-runs on a save of the formats module, and on a
  // save of the config that names another one, also when the config is a symlink to a file outside the root (the
  // watcher reports the file's realpath), and when the formats module is a symlink repointed to another module (the
  // row's `extra`: chokidar's `followSymlinks: false` reports the repoint under the link's own path, and Vite's
  // `resolve.preserveSymlinks` keeps that path in the module graph). Each row prepares the project and returns its
  // edit, which the poll applies again until the load fails, so an edit made before the watcher attaches is not lost.
  it.for([
    {
      edited: "formats module",
      extra: {},
      prepare: (project: Project): DevEdit => ({
        _tag: "Write",
        file: project.path("intl-formats.ts"),
        text: moneyFormats("NOKK"),
      }),
    },
    {
      edited: "config, switched to another formats module",
      extra: {},
      prepare: (project: Project): DevEdit => switchFormats(project, project.path("elmera-intl.json")),
    },
    {
      edited: "config through a symlink, switched to another formats module",
      extra: {},
      prepare: (project: Project): DevEdit => {
        const target = join(outsideRoot(project), "elmera-intl.json");
        writeFileSync(target, project.read("elmera-intl.json"));
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(target, project.path("elmera-intl.json"));

        return switchFormats(project, target);
      },
    },
    {
      edited: "formats module symlink, repointed to another module",
      extra: {
        server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
        resolve: { preserveSymlinks: true },
      },
      prepare: (project: Project): DevEdit => {
        const outside = outsideRoot(project);
        writeFileSync(join(outside, "valid.ts"), project.read("intl-formats.ts"));
        writeFileSync(join(outside, "invalid.ts"), moneyFormats("NOKK"));
        rmSync(project.path("intl-formats.ts"));
        symlinkSync(join(outside, "valid.ts"), project.path("intl-formats.ts"));

        return { _tag: "Link", file: project.path("intl-formats.ts"), target: join(outside, "invalid.ts") };
      },
    },
  ])("loads a catalog with the edited $edited during dev", async ({ prepare, extra }, { project }) => {
    await useMoneyFormats(project, "NOK");
    const edit = prepare(project);
    const server = await devServer(project, {
      server: SERVER_WATCH,
      plugins: [intl()],
      ...extra,
    });
    const load = async () => {
      try {
        await server.ssrLoadModule("/messages/nb.po");

        return "loaded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    await expect(load()).resolves.toBe("loaded");

    await expect
      .poll(
        () => {
          applyEdit(edit);

          return load();
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toMatch(/Invalid currency code : NOKK/u);
  });

  it("adds a message written during dev to the PO", async ({ project }) => {
    await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });
    // A probe synced first, so the edit under test lands on a live watch.
    await untilSynced(project, "src/ready.tsx", "Ready");
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`msgid "New"\nmsgstr ""`);
  });

  // Unit under test: the dev plugin's watch as the dev server closes, when a tree's watcher fails to close. Oracle: the
  // close contract, by hand: Vite awaits every `closeBundle` under `Promise.allSettled`, so a rejection would be read by
  // no one; the watch's end during the close is the server's logger's to report, and the close settles.
  it("logs a watcher's failure to close as the dev server closes", async ({ project }) => {
    const events = deliveredEvents({ closeFails: new Error("watcher close failed") });
    const errors: Array<string> = [];
    const server = await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        error: (message) => {
          errors.push(message);
        },
      },
      plugins: intlPlugins({}, countedServices(CatalogSync.layer(), events.layer).layer),
    });

    await project.within(server.close(), "the close");

    expect(errors).toEqual(["elmera-intl: the catalog watch ended: watcher close failed"]);
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
  // parallel. Oracle: layer 3's lifecycle contract, by hand: a stop during the start opens nothing more, runs no first
  // sync unless it had begun, and returns only after every watcher opened is closed, so a message saved just before the
  // start never reaches the PO, the dev server's start settles cleanly, and no watcher stays open once every hook
  // settles. Each close is safe, the second included: it waits for the same shutdown and finds the runtime already
  // going.
  it.for([1, 2])(
    "closes a watch whose start is still pending when %i environment(s) close the bundle",
    async (closes, { project }) => {
      const before = watches();
      // A real dev server, for the config the plugin reads; the plugin's hooks are called below, as Vite would. Its own
      // file watcher is off: on Linux it opens a handle per directory and file shortly after the server starts, and
      // keeps them until teardown, so only the plugin's watchers are counted.
      const server = await devServer(project, { plugins: [], server: { watch: null } });
      const { configureServer, closeBundle } = hooksOf("elmera-intl:watch");
      expect([configureServer, closeBundle].map((hook) => hook === undefined)).toEqual([false, false]);

      // Unsynced: only a first sync would add it.
      project.write("src/late.tsx", component("Late"));
      const context = devContext(server);

      const starting = configureServer?.call(context, server);
      await project.within(
        Promise.all(Array.from({ length: closes }, () => Promise.resolve(closeBundle?.call(context)))),
        "the closes"
      );
      await expect(project.within(Promise.resolve(starting), "the start")).resolves.toBeUndefined();

      expect(project.read("messages/nb.po")).not.toContain(`msgid "Late"`);
      await expect.poll(watches, project.guard()).toBe(before);
    }
  );

  // Unit under test: the build plugin's own hooks, called on one environment in parallel: two `closeBundle` calls
  // while its `buildStart` check is still reporting (thousands of problems, so the check yields mid-report). Oracle: the built executable, `elmera-intl check` spawned on the same project: the plugin's
  // contract is a build that fails with `elmera-intl check failed:` and exactly what that prints (its problems on
  // stderr, then its summary on stdout), every problem and the summary; and a build after both ends checks again, with
  // the same output.
  it("reports a check in full when its environment's closes land during it, then checks again", async ({
    project,
  }) => {
    project.write(
      "src/many.tsx",
      `import { msg } from "@elmeragroup/intl/react";\n${Array.from(
        { length: 3000 },
        (_, index) => `export const M${index} = msg("Message ${index}");\n`
      ).join("")}`
    );
    const cli = spawnSync(execPath, [BIN, "check"], {
      cwd: project.root,
      encoding: "utf8",
      ...project.spawnGuard(),
    });
    expect(cli.status).toBe(1);
    const { buildStart, closeBundle } = hooksOf("elmera-intl:check");
    // One environment, whose build every hook below belongs to.
    const context = {
      meta: { watchMode: false },
      environment: {
        config: { root: project.root },
        getTopLevelConfig: () => ({ root: project.root, environments: {} }),
      },
      addWatchFile: () => undefined,
      error: (message: string) => {
        throw new Error(message);
      },
    };
    // SAFETY: the check plugin's hooks read only the build's watch mode, the environment (its root, its top-level
    // config's environments for their output directories, none here, and itself as the build's session), addWatchFile
    // and error, which this has.
    const call = <A extends ReadonlyArray<unknown>, R>(hook: ((...args: A) => R) | undefined, ...args: A) =>
      Promise.resolve(hook?.call(context as never, ...args));
    // The build's whole error text, nothing before or after it.
    const report = { message: `elmera-intl check failed:\n${cli.stderr}${cli.stdout}` };

    const checking = call(buildStart, BUILD_OPTIONS);
    const closing = Promise.all([call(closeBundle), call(closeBundle)]);
    await expect(project.within(checking, "the running check")).rejects.toMatchObject(report);
    await project.within(closing, "the closes");

    await expect(project.within(call(buildStart, BUILD_OPTIONS), "the next check")).rejects.toMatchObject(
      report
    );
  });

  // Unit under test: the build plugin's sessions, through one Vite builder whose environments share one top-level
  // config and one plugin instance (`sharedConfigBuild`): the client builds in watch mode, the SSR environment once
  // beside it, then the client rebuilds, then its watcher closes. Oracle: the session contract, by hand: each
  // environment's build owns its runtime, built once and disposed once (the services' layer counts both), so the SSR
  // build's end disposes only its own, the client's rebuild builds nothing, and the client's watcher's close disposes
  // the client's.
  it("keeps a watch build's runtime when another environment of the same builder builds once", async ({
    project,
  }) => {
    const services = countedServices();
    const builder = await createBuilder({
      ...viteConfig(project, {}, { write: true }),
      plugins: intlPlugins({}, services.layer),
      builder: { sharedConfigBuild: true },
      environments: {
        client: { build: { outDir: "dist/client", watch: BUILD_WATCH } },
        ssr: { build: { outDir: "dist/server" } },
      },
    });
    const { client, ssr } = builder.environments;
    expect([client?.name, ssr?.name]).toEqual(["client", "ssr"]);
    if (client === undefined || ssr === undefined) {
      return;
    }

    // SAFETY: with build.watch set, an environment's build returns its watcher (the type is the union of every mode).
    const watcher = (await builder.build(client)) as Rolldown.RolldownWatcher;
    project.defer(() => watcher.close());
    const ends: Array<string> = [];
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END" || event.code === "ERROR") {
        ends.push(event.code);
      }

      if ("result" in event) {
        void event.result.close();
      }
    });
    await expect.poll(() => ends, project.guard()).toEqual(["BUNDLE_END"]);
    const counts = [services.counts()];

    await builder.build(ssr);
    counts.push(services.counts());

    // The entry rewritten until the client's watcher rebuilds it.
    await expect
      .poll(
        () => {
          project.write("src/main.ts", project.read("src/main.ts"));

          return ends.length > 1;
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toBe(true);
    expect(ends.every((end) => end === "BUNDLE_END")).toBe(true);
    counts.push(services.counts());
    await project.within(watcher.close(), "the watcher's close");
    counts.push(services.counts());

    expect(counts).toEqual([
      [1, 0],
      [2, 1],
      [2, 1],
      [2, 2],
    ]);
  });

  // Unit under test: one intl() instance hosting both a dev server and a build, as a config shared by `vite` and
  // `vite build` in one process does. Oracle: layer 2's plugin, by hand: the build's end leaves the dev server's watch
  // running, so a message saved after the build still reaches the PO.
  it("keeps its dev watch syncing after a build of the same instance", async ({ project }) => {
    const plugins = intl();
    await devServer(project, { server: SERVER_WATCH, plugins });
    await expect(build({ ...viteConfig(project), plugins })).resolves.toBeDefined();

    await untilSynced(project, "src/new.tsx", "New");
  });

  // Unit under test: the dev plugin across `server.restart()`, which starts the replacement server (the same plugin
  // instance, from the same inline config) before it closes the old one. Oracle: layer 3's plugin, by hand (73cd948):
  // the old server's close ends only its own watch, so a message saved after the restart still reaches the PO.
  it("keeps syncing after its dev server restarts", async ({ project }) => {
    const server = await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });
    await project.within(server.restart(), "the restart");

    await untilSynced(project, "src/new.tsx", "New");
  });

  // Unit under test: one intl() instance on two dev servers, the second of which fails to start (its logger throws on
  // the first sync's result and on its SyncFailed), then the first server closing. Oracle: layer 3's plugin, by hand
  // (73cd948): the failed start ends only its own watch and runtime, so the first server's watch keeps syncing; each
  // server's runtime is built once and disposed once (the services' layer counts both), the first server's as it closes.
  it("keeps one dev server's watch syncing when another server of the same instance fails to start", async ({
    project,
  }) => {
    const services = countedServices();
    const plugins = intlPlugins({}, services.layer);
    const server = await devServer(project, { server: SERVER_WATCH, plugins });
    const counts = [services.counts()];
    // A second app under the first's root, outside its include, with a message its first sync writes.
    project.write("other/elmera-intl.json", JSON.stringify(CONFIG));
    project.write("other/src/page.tsx", component("Other"));
    const gone = () => {
      throw new Error("logger gone");
    };
    await expect(
      createServer({
        root: project.path("other"),
        configFile: false,
        server: { watch: null },
        customLogger: { ...createLogger("silent"), info: gone, error: gone },
        plugins,
      })
    ).rejects.toThrow("logger gone");
    counts.push(services.counts());

    await untilSynced(project, "src/new.tsx", "New");
    await project.within(server.close(), "the close");
    counts.push(services.counts());

    expect(counts).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
    ]);
  });

  // Unit under test: the built `intl()` in a dev server whose watch ends after its start, with no close coming: a
  // source save's report throws, and so does its SyncFailed (the logger is armed once the server has started). Oracle:
  // Node's own report of an uncaught error, by hand: nothing is left to report the watch's end, so it ends the process,
  // as a report that threw always did, with an error naming its owner and carrying the logger's failure as its cause.
  it("crashes the process with an error naming the catalog watch when it ends on its own", ({ project }) => {
    const script = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createLogger, createServer } from "vite";
      import { intl } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../dist/vite.js", import.meta.url))).href)};
      const [root, source] = process.argv.slice(1);
      let armed = false;
      const gone = () => {
        if (armed) {
          throw new Error("logger gone");
        }
      };
      await createServer({
        root,
        configFile: false,
        server: { watch: { usePolling: true, interval: 50 } },
        customLogger: { ...createLogger("silent"), info: gone, error: gone },
        plugins: [intl()],
      });
      armed = true;
      writeFileSync(join(root, "src/new.tsx"), source);
    `;
    const child = spawnSync(
      execPath,
      ["--input-type=module", "--eval", script, project.root, component("New")],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        ...project.spawnGuard(),
      }
    );

    expect([child.status, child.stderr]).toEqual([
      1,
      expect.stringMatching(
        /Error: elmera-intl: the catalog watch ended[\s\S]*\[cause\]: Error: logger gone/u
      ),
    ]);
  });

  // Unit under test: the dev plugin's choice of how its watch hears a save. Oracle: chokidar's CHOKIDAR_USEPOLLING, by
  // hand: set, it decides the `usePolling` option of Vite's watcher ("false" and "" turn it off over a config that turns
  // it on), and the watch follows that option; `server.watch: null` leaves Vite a watcher with no such option. A watch
  // that listens has opened its listeners by the time the server has started. Unset, the config decides. The cases that
  // poll, the variable's "true" over a config that does not among them, are the cadence table below.
  it.for([
    {
      case: "CHOKIDAR_USEPOLLING=false over server.watch.usePolling",
      env: { CHOKIDAR_USEPOLLING: "false" },
      server: SERVER_WATCH,
    },
    {
      case: "an empty CHOKIDAR_USEPOLLING over server.watch.usePolling",
      env: { CHOKIDAR_USEPOLLING: "" },
      server: SERVER_WATCH,
    },
    { case: "neither CHOKIDAR_USEPOLLING nor server.watch.usePolling", env: {}, server: {} },
    {
      case: "CHOKIDAR_USEPOLLING=true and server.watch null",
      env: { CHOKIDAR_USEPOLLING: "true" },
      server: { watch: null },
    },
  ])("listens to the platform's file events with $case", async ({ env, server }, { project }) => {
    const events = await unheardServer(project, env, { server });

    expect(events.open().length).toBeGreaterThan(0);
  });

  // Unit under test: the cadence of the dev watch's poll. Oracle: the poll interval contract (10 ms to Node's timer
  // maximum), chokidar's CHOKIDAR_INTERVAL, which sets its watcher's interval over `server.watch.interval`, and the
  // watch's 100 ms debounce after the walk that sees a change, by hand. The watch polls at the dev server's watcher's
  // interval; one out of range is reported under the setting it came from and the watch polls at the 100 ms default
  // instead, so a save made once the server has started reaches the PO at 200 ms on the clock, not at 199 ms; one in
  // range (50 ms) over a config out of range is used, with nothing reported, and the save arrives at 150 ms. A watch
  // polling every 10 ms would sync it at 110 ms, one keeping the config's 50 ms at 150 ms. The watch hears no platform
  // event and opens no listener, so the save was polled. CHOKIDAR_USEPOLLING=true over a config that does not poll
  // polls at the watcher's interval as well: CHOKIDAR_INTERVAL's 50 ms, at 150 ms. The sessions run on the test clock and its scheduler, and the project's reads and
  // writes are synchronous, so each move of the clock returns once the syncs it sets off wrote.
  it.for([
    {
      case: "server.watch.interval",
      watch: { usePolling: true, interval: 1 },
      env: {},
      errors: ["elmera-intl: server.watch.interval 1 is outside 10 to 2147483647 ms; polling every 100 ms"],
      syncedAtMs: 200,
    },
    {
      case: "CHOKIDAR_INTERVAL over server.watch.interval",
      watch: { usePolling: true, interval: 50 },
      env: { CHOKIDAR_INTERVAL: "1" },
      errors: ["elmera-intl: CHOKIDAR_INTERVAL 1 is outside 10 to 2147483647 ms; polling every 100 ms"],
      syncedAtMs: 200,
    },
    {
      case: "CHOKIDAR_INTERVAL equal to server.watch.interval",
      watch: { usePolling: true, interval: 1 },
      env: { CHOKIDAR_INTERVAL: "1" },
      errors: ["elmera-intl: CHOKIDAR_INTERVAL 1 is outside 10 to 2147483647 ms; polling every 100 ms"],
      syncedAtMs: 200,
    },
    {
      case: "CHOKIDAR_INTERVAL in range over server.watch.interval",
      watch: { usePolling: true, interval: 1 },
      env: { CHOKIDAR_INTERVAL: "50" },
      errors: [],
      syncedAtMs: 150,
    },
    {
      case: "CHOKIDAR_USEPOLLING over server.watch.usePolling false, at CHOKIDAR_INTERVAL",
      watch: { usePolling: false, interval: 1 },
      env: { CHOKIDAR_USEPOLLING: "true", CHOKIDAR_INTERVAL: "50" },
      errors: [],
      syncedAtMs: 150,
    },
  ])(
    "polls at the dev server watcher's interval, on its clock, reporting one out of range: $case",
    async ({ watch, env, errors, syncedAtMs }, { project }) => {
      const scope = Scope.makeUnsafe();
      project.defer(() => Effect.runPromise(Scope.close(scope, Exit.void)));
      // A woken fiber is waited for up to `warningDelay` before the clock moves on: far past a sync on a loaded host.
      const clock = await Effect.runPromise(
        Layer.buildWithScope(TestClock.layer({ warningDelay: "1 minute" }), scope)
      );
      const at = async (ms: number) => {
        await Effect.runPromise(TestClock.adjust(`${ms} millis`).pipe(Effect.provideContext(clock)));

        return project.read("messages/nb.po").includes(`msgid "New"`);
      };
      const logged: Array<string> = [];
      const events = deliveredEvents();
      await unheardServer(
        project,
        env,
        {
          customLogger: {
            ...createLogger("silent"),
            error: (message) => {
              logged.push(message);
            },
          },
          server: { watch },
        },
        events,
        Layer.mergeAll(syncCatalogServices(), events.layer, Layer.succeedContext(clock))
      );

      project.write("src/new.tsx", component("New"));

      expect({ logged, synced: [await at(syncedAtMs - 1), await at(1)], opened: events.calls() }).toEqual({
        logged: errors,
        synced: [false, true],
        opened: 0,
      });
    }
  );
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

// The text a PO of no configured locale fails with, by the one rule for every host, written out for messages/sv.po.
const SV_NOT_CONFIGURED =
  "elmera-intl: messages/sv.po is not a configured catalog (messages/{locale}.po, nb)";

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
      "1\u00A0234,5 varer",
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

  // Oracle: the one rule for the text a PO of no configured locale fails with on every host (`elmera-intl:`, the PO's
  // path relative to the config, the catalogs pattern and the locales), written out for this fixture. The build wraps
  // the plugin's error; its `errors` hold the plugin's own.
  it("fails the import of a PO of no configured locale", async ({ project }) => {
    await useCount(project);
    project.write("messages/sv.po", project.read("messages/nb.po"));

    await expect(
      buildCatalogs(project, `export { default } from "../messages/sv.po";\n`)
    ).rejects.toMatchObject({
      errors: [{ message: SV_NOT_CONFIGURED }],
    });
  });

  // Unit under test: the `*.po` load hook, through a dev server's plugin container, since Vite's resolver rejects a
  // missing file before `load` in a build or a module load. Oracle: the same rule's text as above: the PO is read only
  // once its locale is known, so a missing PO of no configured locale fails as not configured, not as a missing file.
  it("fails a missing PO of no configured locale as not configured", async ({ project }) => {
    const server = await devServer(project, { plugins: [intlCatalogs()], server: { watch: null } });
    const loading = server.environments.ssr.pluginContainer.load(join(server.config.root, "messages/sv.po"));

    await expect(loading).rejects.toHaveProperty("message", SV_NOT_CONFIGURED);
  });

  // Oracle: the config problem's printed form (problem.ts), the diagnostic the build fails with: its path (under the
  // root, which Vite resolves to its realpath), the ConfigInvalid code and why, then the lead-in of the fix line. The
  // build's `errors` hold the plugin's own error.
  it("fails the import when the config is missing", async ({ project }) => {
    rmSync(project.path("elmera-intl.json"));
    const config = join(realpathSync(project.root), "elmera-intl.json");
    const diagnostic: unknown = expect.stringMatching(
      new RegExp(
        `^${RegExp.escape(`${config}: ConfigInvalid: ${config} not found\n  fix: write elmera-intl.json as `)}`,
        "u"
      )
    );

    await expect(
      buildCatalogs(project, `export { default } from "../messages/nb.po";\n`)
    ).rejects.toMatchObject({
      errors: [{ message: diagnostic }],
    });
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
