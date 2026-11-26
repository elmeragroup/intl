import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HotPayload, InlineConfig, Plugin, ViteDevServer } from "vite";
import { createLogger, createServer } from "vite";
import { describe, expect } from "vitest";

import { CATALOG_UPDATE_EVENT } from "@elmeragroup/intl/internal/catalog";

import { NO_RECORD, syncCatalogs } from "../src/catalog-sync";
import type { ProjectConfig } from "../src/project-config";
import { projectServices } from "../src/project-services";
import { intl } from "../src/vite";
import { intlPlugins } from "../src/vite-plugins";
import { CatalogSync } from "../src/watch";
import type { Project } from "./project-fixture";
import {
  applyEdit,
  component,
  CONFIG,
  countedServices,
  devServer,
  it,
  moneyFormats,
  outsideRoot,
  PROBE_INTERVAL_MS,
  SERVER_WATCH,
  untilSynced,
  useMoneyFormats,
} from "./vite-project";
import { deliveredEvents, syncing } from "./watch-project";

// The config with one more locale.
const SV_CONFIG = { ...CONFIG, locales: ["nb", "sv"] };

// Writes the project's config.
function save(project: Project, text: string): () => void {
  return () => {
    project.write("elmera-intl.json", text);
  };
}

// A locale's PO, as a sync wrote it; none when no sync has.
function catalog(project: Project, locale: string): string {
  const path = `messages/${locale}.po`;

  return existsSync(project.path(path)) ? project.read(path) : "(missing)";
}

// A logger that records every info line, and every error line in `errors` when given; it drops the rest.
function recording(infos: Array<string>, errors: Array<string> = []): InlineConfig["customLogger"] {
  return {
    ...createLogger("silent"),
    info: (message) => {
      infos.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };
}

// Waits until the dev plugin has logged the watch's restart on an edited config: the follow has read the edit (it
// writes `ConfigChanged` as it reads a new text), and the watch running then is being stopped. At least once: an
// in-place save truncates before it writes, so a read between the two is a change of its own.
async function untilRestarting(project: Project, infos: ReadonlyArray<string>): Promise<void> {
  await expect
    .poll(() => infos.some((info) => info.includes("restarting the catalog watch")), project.guard())
    .toBe(true);
}

// The catalog notices the dev server sends open tabs, from now on: what each names, and whether `sv.po` existed then.
function notices(
  project: Project,
  server: ViteDevServer
): Array<{ readonly file: string; readonly sv: boolean }> {
  const sent: Array<{ readonly file: string; readonly sv: boolean }> = [];
  const { hot } = server.environments.client;
  const send = hot.send.bind(hot);
  hot.send = (payload: HotPayload) => {
    if (payload.type === "custom" && payload.event === CATALOG_UPDATE_EVENT) {
      sent.push({ file: JSON.stringify(payload.data), sv: existsSync(project.path("messages/sv.po")) });
    }
    send(payload);
  };

  return sent;
}

// A plugin after `intl()`'s that records when the server's close has called every plugin's `closeBundle`: Vite calls
// them in order, each without waiting for the last, so `intl()`'s has entered its close by then.
function closeClock() {
  let closing = false;

  return {
    plugin: {
      name: "close-clock",
      enforce: "post",
      closeBundle() {
        closing = true;
      },
    } satisfies Plugin,
    closing: () => closing,
  };
}

/** A sync step that holds each sync `holds` picks, until the test releases it. */
type SyncGate = {
  /** Whether the `hold`th held sync (from 0, in the order they began) has begun, and waits. */
  readonly entered: (hold: number) => boolean;
  /** Lets the `hold`th held sync run, once it has begun. */
  readonly release: (hold: number) => void;
  /** Lets every held sync run, and any later one that would be held. */
  readonly releaseAll: () => void;
  /** The plugins' services, counted, on this sync step. */
  readonly services: ReturnType<typeof countedServices>;
};

// By default each first sync of a config naming `sv`. `call` counts the syncs from 0, the server's own start sync.
function syncGate(
  holds: (config: ProjectConfig, call: number) => boolean = (config) => config.locales.includes("sv")
): SyncGate {
  let calls = 0;
  let open = false;
  const held: Array<PromiseWithResolvers<void>> = [];
  const services = countedServices(
    syncing((config: ProjectConfig) => {
      const call = calls;
      calls += 1;

      if (open || !holds(config, call)) {
        return syncCatalogs(config);
      }

      const gate = Promise.withResolvers<void>();
      held.push(gate);

      return Effect.promise(() => gate.promise).pipe(Effect.andThen(syncCatalogs(config)));
    })
  );

  return {
    entered: (hold) => held.length > hold,
    release: (hold) => held[hold]?.resolve(),
    releaseAll: () => {
      open = true;
      held.forEach((gate) => {
        gate.resolve();
      });
    },
    services,
  };
}

// A dev server on the project with `intl()`'s plugins on the gate's services and `extra` after them. Every hold is
// released before the server's teardown (`project.defer` runs the last registered first), so a test that fails while
// a sync is held never leaves the server's close waiting for it.
async function gatedServer(
  project: Project,
  gate: SyncGate,
  extra: ReadonlyArray<Plugin>,
  config: InlineConfig = {}
): Promise<ViteDevServer> {
  const server = await devServer(project, {
    server: SERVER_WATCH,
    plugins: [...intlPlugins({}, gate.services.layer), ...extra],
    ...config,
  });
  project.defer(gate.releaseAll);

  return server;
}

// Saves a source, again each probe interval, until the gate holds a sync of it (the gate's first hold).
async function untilSourceHeld(project: Project, gate: SyncGate): Promise<void> {
  await expect
    .poll(
      () => {
        project.write("src/new.tsx", component("New"));

        return gate.entered(0);
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toBe(true);
}

// A PO import's load through the dev server: "loaded", or the error it failed with.
async function load(server: ViteDevServer): Promise<string> {
  try {
    await server.ssrLoadModule("/messages/nb.po");

    return "loaded";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Unit under test: the dev plugin's watch across edits of `elmera-intl.json` while a real dev server runs, polling
// (#52). The watch reads the config itself (`followConfig`), so one write of it is enough, wherever it lies; every wait
// is on the follow's own report (its restart line) or on the catalogs. Oracle: the config contract, by hand: a watch
// syncs one catalog per configured locale, its start included, so after an edit adding `sv` the watch has written
// `messages/sv.po` with the project's message, and a message saved later reaches it.
describe("intl() vite dev config", { timeout: 15_000 }, () => {
  // Rows: the config in the Vite root or outside it (`options.config`, which Vite's own watcher does not cover), and an
  // edit that makes the config invalid on the way: the edit after it is followed all the same.
  it.for([
    { edits: "an edit of its config", outside: false, invalidFirst: false },
    { edits: "an edit that fixes its config after an invalid one", outside: false, invalidFirst: true },
    { edits: "an edit of its config outside the Vite root", outside: true, invalidFirst: false },
  ])("follows $edits during dev", async ({ outside, invalidFirst }, { project }) => {
    const errors: Array<string> = [];
    const logger = recording([], errors);

    if (outside) {
      mkdirSync(project.path("app"));
      await devServer(project, {
        root: project.path("app"),
        customLogger: logger,
        server: SERVER_WATCH,
        plugins: [intl({ config: "../elmera-intl.json" })],
      });
    } else {
      await devServer(project, { customLogger: logger, server: SERVER_WATCH, plugins: [intl()] });
    }

    if (invalidFirst) {
      save(project, "{")();
      await expect
        .poll(() => errors.some((error) => error.includes("ConfigInvalid")), project.guard())
        .toBe(true);
    }

    save(project, JSON.stringify(SV_CONFIG))();
    await expect.poll(() => catalog(project, "sv"), project.guard()).toContain(`msgid "Hello"`);

    await untilSynced(project, "src/new.tsx", "New", "messages/sv.po");
  });

  // Unit under test: the dev plugin when the server starts on a config that does not parse, or on none, then a config
  // adding `sv` is written (#52). Oracle: the watch contract, by hand: the server starts all the same, and a watch's
  // start syncs, so once the config is fixed a message the PO lacked before the server started is in it; and the
  // reload contract: a tab told reloads its catalogs, so it is told again once the new watch has written them, when
  // `sv.po` exists (a new locale's PO is a file no module imports yet, which no PO save announces).
  it.for([
    { start: "does not parse", setup: (project: Project) => project.write("elmera-intl.json", "{") },
    { start: "is missing", setup: (project: Project) => rmSync(project.path("elmera-intl.json")) },
  ])("starts its watch when a config that $start is fixed during dev", async ({ setup }, { project }) => {
    project.write("src/new.tsx", component("New"));
    setup(project);
    const server = await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });
    const sent = notices(project, server);
    const config = JSON.stringify({ file: join(server.config.root, "elmera-intl.json") });
    save(project, JSON.stringify(SV_CONFIG))();

    await expect.poll(() => catalog(project, "nb"), project.guard()).toContain(`msgid "New"`);
    await expect.poll(() => sent.some(({ file, sv }) => file === config && sv), project.guard()).toBe(true);
  });

  // Unit under test: the dev server's close while the watch restarts on an edited config, the new watch's first sync
  // held (the services' sync step). Oracle: the close contract, by hand: a watch's close lets a running sync finish,
  // so the held sync has written `sv.po` once the close settles; and the server's watch builds its services once and
  // releases them once as it ends: `[built, released]` is `[1, 1]`. The hold is released once the plugin's close has
  // begun.
  it("closes the watch a restart is starting when the dev server closes", async ({ project }) => {
    const gate = syncGate();
    const clock = closeClock();
    const server = await gatedServer(project, gate, [clock.plugin]);
    save(project, JSON.stringify(SV_CONFIG))();
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);

    const closing = server.close();
    await expect.poll(() => clock.closing(), project.guard()).toBe(true);
    gate.release(0);
    await project.within(closing, "the close");

    expect([catalog(project, "sv"), gate.services.counts()]).toEqual([
      expect.stringContaining(`msgid "Hello"`),
      [1, 1],
    ]);
  });

  // Unit under test: the dev server's close while the watch's restart on an edited config is still stopping the old
  // watch, whose sync of a source save is held. Oracle: the close contract, by hand: a close during a restart starts
  // nothing more, so once the close settles the restart has been logged but no watch on the edited config ever synced
  // (no `sv.po`), and the services were built and released once. The hold is released once the plugin's close has
  // begun.
  it("starts no watch from a restart the dev server closes during", async ({ project }) => {
    // The first sync after the server's start sync: the old watch's, of the save below.
    const gate = syncGate((_config, call) => call === 1);
    const infos: Array<string> = [];
    const clock = closeClock();
    const server = await gatedServer(project, gate, [clock.plugin], { customLogger: recording(infos) });
    await untilSourceHeld(project, gate);

    save(project, JSON.stringify(SV_CONFIG))();
    await untilRestarting(project, infos);
    const closing = server.close();
    await expect.poll(() => clock.closing(), project.guard()).toBe(true);
    gate.release(0);
    await project.within(closing, "the close");

    expect([catalog(project, "sv"), gate.services.counts()]).toEqual(["(missing)", [1, 1]]);
  });

  // Unit under test: what the dev plugin sends open tabs as the watch restarts on an edited config adding `sv`, the new
  // watch's first sync held. Oracle: the reload contract, by hand: a tab told reloads its catalogs, at least once and
  // never held back. So a notice naming the config goes out at the change (the catalogs compile against the edited
  // config), before `sv.po` exists, and another once the new watch has written its first result, when `sv.po` exists:
  // a new locale's PO is a file no module imports yet, which no PO save announces. At least one at the change, not
  // exactly one: the save is in place, as most editors make it, and a read between its truncate and its write is a
  // change of its own (the contract pairs no change with one notice).
  it("tells open tabs about a config edit, and again once the new watch has written its catalogs", async ({
    project,
  }) => {
    const gate = syncGate();
    const server = await gatedServer(project, gate, []);
    const sent = notices(project, server);
    // The plugin names the config as Vite resolves its root; a PO's own notice (Vite's watcher seeing `sv.po` created)
    // may come as well.
    const config = JSON.stringify({ file: join(server.config.root, "elmera-intl.json") });
    const told = () => sent.filter(({ file }) => file === config);
    save(project, JSON.stringify(SV_CONFIG))();
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);
    const whileHeld = [...told()];

    gate.release(0);
    await expect.poll(() => told().some(({ sv }) => sv), project.guard()).toBe(true);

    expect({ told: whileHeld.length > 0, withSv: whileHeld.some(({ sv }) => sv) }).toEqual({
      told: true,
      withSv: false,
    });
  });

  // Unit under test: the notice to open tabs of a config edit that makes the config invalid, when the server's logger
  // throws on the restart line (a plugin's logger wrapper, say). Oracle: the reload contract, by hand: the catalogs
  // compile against the config as it is, so a tab is told at the change whatever the log line does; no restarted watch
  // follows an invalid config to tell it later.
  it("tells open tabs about a config edit when the logger throws on the restart line", async ({
    project,
  }) => {
    const errors: Array<string> = [];
    const server = await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          if (message.includes("restarting the catalog watch")) {
            throw new Error("logger gone");
          }
        },
        error: (message) => {
          errors.push(message);
        },
      },
      server: SERVER_WATCH,
      plugins: [intl()],
    });
    const sent = notices(project, server);
    const config = JSON.stringify({ file: join(server.config.root, "elmera-intl.json") });
    save(project, "{")();
    await expect
      .poll(() => errors.some((error) => error.includes("ConfigInvalid")), project.guard())
      .toBe(true);

    // At least once, as the save is in place (see the test above).
    expect(sent.some(({ file }) => file === config)).toBe(true);
  });

  // Unit under test: what the dev plugin sends open tabs when the watch's first sync after a config edit adding `sv` is
  // superseded (a PO save between its read and its write, stood in by the sync step), so its retry writes `sv.po`
  // after the restart's notice. The config and catalogs lie outside the Vite root and `server.watch` is null, so no
  // notice can come from Vite's watcher. Oracle: the reload contract, by hand: a tab told reloads its catalogs, and a
  // notice follows every sync that reports what it wrote, so once the retry is let run, a notice naming the config that
  // the restart's own notice did not already count goes out with `sv.po` existing (#85).
  it("tells open tabs about a new locale's PO that a superseded first sync's retry writes, with no Vite watcher", async ({
    project,
  }) => {
    let superseded: number | undefined;
    const retry = Promise.withResolvers<void>();
    let retrying = false;
    const services = countedServices(
      syncing((config: ProjectConfig) => {
        if (!config.locales.includes("sv")) {
          return syncCatalogs(config);
        }

        if (superseded === undefined) {
          return Effect.sync(() => {
            superseded = sent.length;

            return { _tag: "Synced", written: [], superseded: true, left: NO_RECORD } as const;
          });
        }

        return Effect.sync(() => {
          retrying = true;
        }).pipe(Effect.andThen(Effect.promise(() => retry.promise)), Effect.andThen(syncCatalogs(config)));
      })
    );
    mkdirSync(project.path("app"));
    const server = await devServer(project, {
      root: project.path("app"),
      server: { watch: null },
      plugins: [...intlPlugins({ config: "../elmera-intl.json" }, services.layer)],
    });
    project.defer(() => {
      retry.resolve();
    });
    const sent = notices(project, server);
    const config = JSON.stringify({ file: resolve(server.config.root, "../elmera-intl.json") });
    save(project, JSON.stringify(SV_CONFIG))();
    // The restart's own notice (`Restarted`), after the superseded sync, before `sv.po` exists; the retry then runs.
    await expect
      .poll(() => superseded !== undefined && sent.length > superseded && retrying, project.guard())
      .toBe(true);
    const atRestart = sent.slice(superseded).some(({ file, sv }) => file === config && !sv);
    const beforeRetry = sent.length;
    retry.resolve();

    expect(atRestart).toBe(true);
    await expect
      .poll(() => sent.slice(beforeRetry).some(({ file, sv }) => file === config && sv), project.guard())
      .toBe(true);
  });

  // Unit under test: the dev server's start when its config is edited during the start's first sync (held), and the
  // new watch's first sync is held in turn. Oracle: the start contract, by hand: `createServer` resolves once the watch
  // on the config as it is when a first sync's result is written has synced, so a plugin that configures the server
  // after `intl()` finds `sv.po`; and none has configured it while the new watch's sync is held.
  it("finishes starting once the watch on a config edited during its start has synced", async ({
    project,
  }) => {
    // The server's start sync (call 0), and the first sync of the edited config.
    const gate = syncGate((config, call) => call === 0 || config.locales.includes("sv"));
    const infos: Array<string> = [];
    // Whether `sv.po` existed when the next plugin configured the server.
    let configured: boolean | undefined;
    const opening = createServer({
      root: project.root,
      configFile: false,
      customLogger: recording(infos),
      server: SERVER_WATCH,
      plugins: [
        ...intlPlugins({}, gate.services.layer),
        {
          name: "configures-after",
          configureServer() {
            configured = existsSync(project.path("messages/sv.po"));
          },
        },
      ],
    });
    // One teardown, whatever point the test fails at: the holds go first, so the start can end, then the server it
    // made, if it made one.
    project.defer(async () => {
      gate.releaseAll();
      // The close chained onto the start, so a server that opens past the deadline is still closed.
      await project.within(
        opening.then(
          (server) => server.close(),
          () => undefined
        ),
        "the start and its close at teardown"
      );
    });
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);
    save(project, JSON.stringify(SV_CONFIG))();
    // The follow has read the edit before the start sync's result is written.
    await untilRestarting(project, infos);
    gate.release(0);
    await expect.poll(() => gate.entered(1), project.guard()).toBe(true);
    const whileHeld = configured;

    gate.release(1);
    await project.within(opening, "the start");

    expect({ whileHeld, configured }).toEqual({ whileHeld: undefined, configured: true });
  });

  // Unit under test: the dev server's start when its first watch fails to start on its own (its sources' tree refused
  // as it opens, the catalogs' tree already open), and its config is edited while that failed start's cleanup is held
  // (a host watcher that closes asynchronously). The watch uses native events, through a fake that opens the trees (a
  // polled watch opens none), and reads the config itself. Oracle: the start contract, by hand: the follow settles its
  // start from the watch on the config waiting once the failed one is gone, so `createServer` resolves, on the edited
  // config's watch, which has written `sv.po`; the refused start's failure is not the start's.
  it("finishes starting on a config edited while a failed first start cleans up", async ({ project }) => {
    // The watch names its trees from the canonical root. The catalogs' tree opens first (path order); the sources'
    // tree is refused once, to the first watch alone.
    const root = realpathSync(project.root);
    let refused = false;
    const cleanup = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const events = deliveredEvents({
      opening: (dir) => {
        if (refused || dir !== join(root, "src")) {
          return undefined;
        }

        refused = true;

        return Promise.reject(new Error("EACCES: permission denied, watch"));
      },
      releasing: () => {
        cleanup.resolve();

        return held.promise;
      },
    });
    const infos: Array<string> = [];
    const opening = createServer({
      root: project.root,
      configFile: false,
      customLogger: recording(infos),
      plugins: [
        ...intlPlugins(
          {},
          Layer.mergeAll(Layer.provideMerge(CatalogSync.layer(), projectServices()), events.layer)
        ),
      ],
    });
    const outcome = (async () => {
      try {
        await opening;

        return "started";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    // One teardown, whatever point the test fails at: the cleanup goes first, so the start can end, then the server
    // it made, if it made one.
    project.defer(async () => {
      held.resolve();
      // The close chained onto the start, so a server that opens past the deadline is still closed.
      await project.within(
        opening.then(
          (server) => server.close(),
          () => undefined
        ),
        "the start and its close at teardown"
      );
    });
    await project.within(cleanup.promise, "the failed start's cleanup");
    save(project, JSON.stringify(SV_CONFIG))();
    await untilRestarting(project, infos);
    held.resolve();

    expect([await project.within(outcome, "the start"), catalog(project, "sv")]).toEqual([
      "started",
      expect.stringContaining(`msgid "Hello"`),
    ]);
  });

  // Unit under test: the dev plugin on a config link to a target outside the root, repointed to another target outside
  // it (a deploy swapping versions), which is then edited to add `sv`. Oracle: the follow reads the config through the
  // link, whatever Vite's watcher reports (it watches neither target), so the edit of the target the link points at
  // now is followed: `sv.po` gets the project's message.
  it("follows an edit of the target outside the root a config link is repointed to", async ({ project }) => {
    const outside = outsideRoot(project);
    const old = join(outside, "old", "elmera-intl.json");
    const next = join(outside, "next", "elmera-intl.json");
    [old, next].forEach((target) => {
      mkdirSync(dirname(target));
      writeFileSync(target, project.read("elmera-intl.json"));
    });
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(old, project.path("elmera-intl.json"));
    await devServer(project, { server: SERVER_WATCH, plugins: [intl()] });

    applyEdit({ _tag: "Link", file: project.path("elmera-intl.json"), target: next });
    writeFileSync(next, JSON.stringify(SV_CONFIG));

    await expect.poll(() => catalog(project, "sv"), project.guard()).toContain(`msgid "Hello"`);
  });

  // Unit under test: a PO import across a repoint of the config symlink to another config, during dev (#52's comment).
  // Oracle: Intl rejects the currency "NOKK", which only the repointed config's formats module makes reachable. Vite
  // invalidates no module for a link it reports as created (`followSymlinks: false`); the plugin invalidates every
  // compiled catalog as the watch restarts, so once it has, the next load compiles with the new target.
  it("loads a catalog with the config symlink repointed during dev", async ({ project }) => {
    await useMoneyFormats(project, "NOK");
    project.write("intl-formats-next.ts", moneyFormats("NOKK"));
    const outside = outsideRoot(project);
    writeFileSync(join(outside, "valid.json"), project.read("elmera-intl.json"));
    writeFileSync(
      join(outside, "invalid.json"),
      JSON.stringify({ ...CONFIG, formats: project.path("intl-formats-next.ts") })
    );
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(join(outside, "valid.json"), project.path("elmera-intl.json"));
    const infos: Array<string> = [];
    const server = await devServer(project, {
      customLogger: recording(infos),
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [intl()],
    });
    await expect(load(server)).resolves.toBe("loaded");

    applyEdit({
      _tag: "Link",
      file: project.path("elmera-intl.json"),
      target: join(outside, "invalid.json"),
    });
    await untilRestarting(project, infos);

    await expect(load(server)).resolves.toMatch(/Invalid currency code : NOKK/u);
  });

  // Unit under test: a PO import loaded while the watch restarts on a config symlink repoint, the new watch's first
  // sync held. Oracle: Intl rejects the currency "NOKK", which only the repointed config's formats module makes
  // reachable. The plugin invalidates the compiled catalogs at the change, before the new watch has synced, so a load
  // in between compiles with the config as it is.
  it("compiles a catalog with a repointed config before the new watch has synced", async ({ project }) => {
    await useMoneyFormats(project, "NOK");
    project.write("intl-formats-next.ts", moneyFormats("NOKK"));
    const outside = outsideRoot(project);
    writeFileSync(join(outside, "valid.json"), project.read("elmera-intl.json"));
    writeFileSync(
      join(outside, "invalid.json"),
      JSON.stringify({ ...CONFIG, formats: project.path("intl-formats-next.ts") })
    );
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(join(outside, "valid.json"), project.path("elmera-intl.json"));
    const gate = syncGate((config) => config.formats?.endsWith("intl-formats-next.ts") === true);
    const server = await gatedServer(project, gate, [], {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
    });
    await expect(load(server)).resolves.toBe("loaded");

    applyEdit({
      _tag: "Link",
      file: project.path("elmera-intl.json"),
      target: join(outside, "invalid.json"),
    });
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);

    await expect(load(server)).resolves.toMatch(/Invalid currency code : NOKK/u);
  });

  // Unit under test: the notice to open tabs of a PO save made while the dev watch restarts on an edited config adding
  // `sv`, the new watch's first sync held, when that sync then dies, so the new watch fails to start. Oracle: the
  // reload contract, by hand: a tab told nothing keeps a stale catalog, so a PO save is announced to open tabs as Vite
  // reports it, whatever the restart around it does: one notice naming `nb.po` while the restart is held, and still
  // that one once the failed start is logged.
  it("tells open tabs about a PO save made during a restart whose new watch fails to start", async ({
    project,
  }) => {
    const held = Promise.withResolvers<void>();
    let entered = false;
    const services = countedServices(
      syncing((config: ProjectConfig) =>
        config.locales.includes("sv")
          ? Effect.sync(() => {
              entered = true;
            }).pipe(
              Effect.andThen(Effect.promise(() => held.promise)),
              Effect.andThen(Effect.die(new Error("sync crashed")))
            )
          : syncCatalogs(config)
      )
    );
    const errors: Array<string> = [];
    let nbHandled = 0;
    const server = await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        error: (message) => {
          errors.push(message);
        },
      },
      server: SERVER_WATCH,
      plugins: [
        ...intlPlugins({}, services.layer),
        {
          name: "nb-clock",
          enforce: "post",
          hotUpdate({ file }) {
            if (this.environment.name === "client" && file.endsWith("/messages/nb.po")) {
              nbHandled += 1;
            }
          },
        },
      ],
    });
    // Before the server's close (`project.defer` runs the last registered first), so the close never waits on the hold.
    project.defer(() => {
      held.resolve();
    });
    const poNotices: Array<string> = [];
    const { hot } = server.environments.client;
    const send = hot.send.bind(hot);
    hot.send = (payload: HotPayload) => {
      if (
        payload.type === "custom" &&
        payload.event === CATALOG_UPDATE_EVENT &&
        JSON.stringify(payload.data).endsWith(`/messages/nb.po"}`)
      ) {
        poNotices.push(JSON.stringify(payload.data));
      }
      send(payload);
    };
    // Saved again each probe interval until the new watch's first sync is held: a poll watcher can miss a write made
    // before it attached.
    await expect
      .poll(
        () => {
          if (!entered) {
            save(project, JSON.stringify(SV_CONFIG))();
          }

          return entered;
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toBe(true);

    // A translator's save of `nb.po`, reported as chokidar reports it.
    server.watcher.emit("change", project.path("messages/nb.po"));
    await expect.poll(() => nbHandled, project.guard()).toBe(1);
    const whileHeld = poNotices.length;
    held.resolve();
    await expect
      .poll(() => errors.some((error) => error.includes("did not start")), project.guard())
      .toBe(true);

    expect({ whileHeld, told: poNotices.length }).toEqual({ whileHeld: 1, told: 1 });
  });
});
