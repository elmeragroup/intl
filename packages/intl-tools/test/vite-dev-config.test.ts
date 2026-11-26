import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HotPayload, InlineConfig, Plugin, ViteDevServer } from "vite";
import { createLogger, createServer } from "vite";
import { describe, expect } from "vitest";

import { CATALOG_UPDATE_EVENT } from "@elmeragroup/intl/internal/catalog";

import { syncCatalogs } from "../src/catalog-sync";
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

// The config with one more locale, and with another.
const SV_CONFIG = { ...CONFIG, locales: ["nb", "sv"] };
const FI_CONFIG = { ...CONFIG, locales: ["nb", "fi"] };

/** Vite's reports of a change to `elmera-intl.json`, seen from a plugin that runs last. */
type ConfigClock = {
  /** The plugin, placed after `intl()`'s. */
  readonly plugin: Plugin;
  /** How many reports every plugin's `watchChange` has been called for. */
  readonly reported: () => number;
  /** How many reports Vite has finished handling: each one's `hotUpdate`, after it awaited every `watchChange`. */
  readonly handled: () => number;
  /**
   * Whether the server's close has called every plugin's `closeBundle`: Vite calls them in order, each without
   * waiting for the last, so `intl()`'s has entered its close by then.
   */
  readonly closing: () => boolean;
};

// Vite calls every plugin's `watchChange` for a report together (in the client environment alone, by default), awaits
// them all, then runs each plugin's `hotUpdate` in turn, the client environment's first. So once this plugin's
// `hotUpdate` has run for every report its `watchChange` saw, `intl()`'s `watchChange` has settled for each of them.
function configClock(): ConfigClock {
  let reported = 0;
  let handled = 0;
  let closing = false;
  const isConfig = (file: string) => file.endsWith("/elmera-intl.json");

  return {
    plugin: {
      name: "config-clock",
      enforce: "post",
      watchChange(id) {
        if (isConfig(id)) {
          reported += 1;
        }
      },
      hotUpdate({ file }) {
        if (this.environment.name === "client" && isConfig(file)) {
          handled += 1;
        }
      },
      closeBundle() {
        closing = true;
      },
    },
    reported: () => reported,
    handled: () => handled,
    closing: () => closing,
  };
}

// Makes `edit` (again each probe interval, until Vite reports a change after it: a poll watcher can miss a write made
// before it attached), and returns once Vite has handled every report so far. A report Vite made after the edit was
// written is among them, and `intl()`'s follow of it read the config after the edit.
async function untilHandled(project: Project, clock: ConfigClock, edit: () => void): Promise<void> {
  const before = clock.reported();
  await expect
    .poll(
      () => {
        if (clock.reported() === before) {
          edit();
        }

        return clock.reported() > before && clock.handled() === clock.reported();
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toBe(true);
}

// How many notices naming the project's config the dev server has sent open tabs, from now on.
function toldConfig(server: ViteDevServer): () => number {
  let told = 0;
  const { hot } = server.environments.client;
  const send = hot.send.bind(hot);
  hot.send = (payload: HotPayload) => {
    if (
      payload.type === "custom" &&
      payload.event === CATALOG_UPDATE_EVENT &&
      JSON.stringify(payload.data) === JSON.stringify({ file: join(server.config.root, "elmera-intl.json") })
    ) {
      told += 1;
    }
    send(payload);
  };

  return () => told;
}

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

// Whether the dev server's own watcher watches `file`, an existing file, by its directory's realpath (as Vite roots it).
function watchedBy(server: ViteDevServer, file: string): boolean {
  return server.watcher.getWatched()[realpathSync(dirname(file))]?.includes(basename(file)) === true;
}

// Records every path a plugin adds to the dev server's watcher, from a plugin that configures the server first.
function watcherAdds() {
  const added: Array<string> = [];

  return {
    plugin: {
      name: "records-watcher-adds",
      enforce: "pre",
      configureServer(server) {
        const add = server.watcher.add.bind(server.watcher);
        server.watcher.add = (paths) => {
          added.push(...[paths].flat());

          return add(paths);
        };
      },
    } satisfies Plugin,
    added: (): ReadonlyArray<string> => added,
  };
}

// A dev server config on the project that `clock` watches: rooted at the project, or at `app/` below it with
// `intl()`'s config pointing up at the project's, outside the Vite root.
function followingServer(project: Project, outside: boolean, clock: ConfigClock): InlineConfig {
  if (!outside) {
    return { server: SERVER_WATCH, plugins: [intl(), clock.plugin] };
  }

  mkdirSync(project.path("app"));

  return {
    root: project.path("app"),
    server: SERVER_WATCH,
    plugins: [intl({ config: "../elmera-intl.json" }), clock.plugin],
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

// Makes `edit` (by default, saves the `sv` config), again each probe interval, until the gate's `hold`th sync is held, or (with nothing following
// the config) until Vite has handled the save, which waits for a held sync's release.
async function untilHeld(
  project: Project,
  clock: ConfigClock,
  gate: SyncGate,
  hold = 0,
  edit: () => void = save(project, JSON.stringify(SV_CONFIG))
): Promise<void> {
  const before = clock.reported();
  await expect
    .poll(
      () => {
        edit();

        return gate.entered(hold) || (clock.reported() > before && clock.handled() === clock.reported());
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toBe(true);
  expect(gate.entered(hold)).toBe(true);
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

// Saves `text` and waits until Vite has reported a change after it, saving it again each probe interval only while
// none is reported (a poll watcher misses a write made before it attached). The writing stops before the test's next
// save, so no write of `text` lands after it; and once Vite's watcher has reported the config, the first write is the
// only one.
async function savedOnce(project: Project, clock: ConfigClock, text: string): Promise<void> {
  const reported = clock.reported();
  await expect
    .poll(
      () => {
        if (clock.reported() === reported) {
          save(project, text)();
        }

        return clock.reported() > reported;
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toBe(true);
}

// Waits until Vite has handled every report so far: each `watchChange` of `intl()`'s, and the follow it awaited.
async function untilAllHandled(project: Project, clock: ConfigClock): Promise<void> {
  await expect.poll(() => clock.handled() === clock.reported(), project.guard()).toBe(true);
}

// Unit under test: the dev plugin's watch across edits of `elmera-intl.json` while the dev server runs (#52). Oracle:
// the config contract, by hand: a watch syncs one catalog per configured locale, its start included, so once Vite has
// handled an edit adding `sv`, the watch on it has written `messages/sv.po` with the project's message, and a message
// saved after the edit reaches it.
describe("intl() vite dev config", { timeout: 15_000 }, () => {
  // Rows: the config in the Vite root or outside it (`options.config`, which only the plugin adds to Vite's watcher),
  // and an edit that makes the config invalid on the way: the edit after it is followed all the same.
  it.for([
    { edits: "an edit of its config", outside: false, invalidFirst: false },
    { edits: "an edit that fixes its config after an invalid one", outside: false, invalidFirst: true },
    { edits: "an edit of its config outside the Vite root", outside: true, invalidFirst: false },
  ])("follows $edits during dev", async ({ outside, invalidFirst }, { project }) => {
    const clock = configClock();
    const adds = watcherAdds();
    const config = followingServer(project, outside, clock);
    const server = await devServer(project, { ...config, plugins: [adds.plugin, ...(config.plugins ?? [])] });
    // Vite's watcher covers its root; the plugin adds a config outside it, and only that one. (Vite adds directories
    // of its own, such as a package's.)
    expect(adds.added().filter((path) => basename(path) === "elmera-intl.json")).toEqual(
      outside ? [join(realpathSync(project.root), "elmera-intl.json")] : []
    );
    await expect.poll(() => watchedBy(server, project.path("elmera-intl.json")), project.guard()).toBe(true);

    if (invalidFirst) {
      await untilHandled(project, clock, save(project, "{"));
    }

    await untilHandled(project, clock, save(project, JSON.stringify(SV_CONFIG)));
    expect(catalog(project, "sv")).toContain(`msgid "Hello"`);

    await untilSynced(project, "src/new.tsx", "New", "messages/sv.po");
  });

  // Unit under test: the dev plugin when the server starts on a config that does not parse, or on none, then the config
  // is written (#52). Oracle: the watch contract, by hand: a watch's start syncs, so once Vite has handled the fix, a
  // message the PO lacked before the server started is in it.
  it.for([
    { start: "does not parse", setup: (project: Project) => project.write("elmera-intl.json", "{") },
    { start: "is missing", setup: (project: Project) => rmSync(project.path("elmera-intl.json")) },
  ])("starts its watch when a config that $start is fixed during dev", async ({ setup }, { project }) => {
    project.write("src/new.tsx", component("New"));
    setup(project);
    const clock = configClock();
    await devServer(project, followingServer(project, false, clock));
    await untilHandled(project, clock, save(project, JSON.stringify(CONFIG)));

    expect(catalog(project, "nb")).toContain(`msgid "New"`);
  });

  // Unit under test: the dev server's close while a follow of a config edit is starting the new watch, its first sync
  // held (the services' sync step). Oracle: the close contract, by hand: a watch's close lets a running sync finish,
  // so the held sync has written `sv.po` once the close settles; and every watch runs on the server's one runtime,
  // which the close disposes once, so no watch is left to sync: `[built, disposed]` is `[1, 1]`. The hold is released
  // once the plugin's close has begun.
  it("closes the watch a follow of its config is starting when the dev server closes", async ({
    project,
  }) => {
    const gate = syncGate();
    const clock = configClock();
    const server = await gatedServer(project, gate, [clock.plugin]);
    await untilHeld(project, clock, gate);

    const closing = server.close();
    await expect.poll(() => clock.closing(), project.guard()).toBe(true);
    gate.release(0);
    await project.within(closing, "the close");

    expect([catalog(project, "sv"), gate.services.counts()]).toEqual([
      expect.stringContaining(`msgid "Hello"`),
      [1, 1],
    ]);
  });

  // Unit under test: the dev server's close while a follow of a config edit is still closing the old watch, whose sync
  // of a source save is held. Oracle: the close contract, by hand: a close during a follow starts nothing more, so once
  // the close settles the follow has logged its restart but no watch on the edited config ever synced (no `sv.po`), and
  // the server's one runtime is disposed once. The hold is released once the plugin's close has begun.
  it("starts no watch from a follow the dev server closes during", async ({ project }) => {
    // The first sync after the server's start sync: the old watch's, of the save below.
    const gate = syncGate((_config, call) => call === 1);
    const infos: Array<string> = [];
    const clock = configClock();
    const server = await gatedServer(project, gate, [clock.plugin], {
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          infos.push(message);
        },
      },
    });
    await untilSourceHeld(project, gate);

    // Once Vite has called every `watchChange` for the edit, the follow is closing the old watch, which waits for its
    // held sync.
    await savedOnce(project, clock, JSON.stringify(SV_CONFIG));
    const closing = server.close();
    await expect.poll(() => clock.closing(), project.guard()).toBe(true);
    gate.release(0);
    await project.within(closing, "the close");

    expect([
      infos.some((info) => info.includes("restarting the catalog watch")),
      catalog(project, "sv"),
      gate.services.counts(),
    ]).toEqual([true, "(missing)", [1, 1]]);
  });

  // Unit under test: the dev plugin's follow when the config changes again while a follow is starting a watch, its
  // first sync held. Oracle: the follow contract, by hand: a report during a follow schedules one more, which reads
  // the config as it is then, so once Vite has handled every report, the last config's watch has synced `fi.po`, and a
  // message saved after both edits reaches it.
  it("follows a config edit made while a follow of an earlier one is starting", async ({ project }) => {
    const gate = syncGate();
    const clock = configClock();
    await gatedServer(project, gate, [clock.plugin]);
    await untilHeld(project, clock, gate);

    await savedOnce(project, clock, JSON.stringify(FI_CONFIG));
    gate.release(0);
    await untilAllHandled(project, clock);
    expect(catalog(project, "fi")).toContain(`msgid "Hello"`);

    await untilSynced(project, "src/new.tsx", "New", "messages/fi.po");
  });

  // Unit under test: the dev plugin's follow across three saves, each landing during a different step of the follow
  // in flight: `sv` while it closes the old watch (whose sync of a source save is held), `fi` before it starts the new
  // one, and `sv` again while that start's first sync is held. Oracle: the config on disk, by hand: it ends as `sv`,
  // so once Vite has handled every report, the watch running is on `sv` (it wrote `sv.po`, and no watch ever started on
  // `fi`), and a message saved later reaches `sv.po`.
  it("follows the config on disk after saves during a follow's close and its start", async ({ project }) => {
    // The old watch's sync of the source save below (call 1), and the next sync: the new watch's first.
    const gate = syncGate((_config, call) => call >= 1);
    const clock = configClock();
    await gatedServer(project, gate, [clock.plugin]);
    await untilSourceHeld(project, gate);

    await savedOnce(project, clock, JSON.stringify(SV_CONFIG));
    await savedOnce(project, clock, JSON.stringify(FI_CONFIG));
    gate.release(0);
    await expect.poll(() => gate.entered(1), project.guard()).toBe(true);
    await savedOnce(project, clock, JSON.stringify(SV_CONFIG));
    gate.releaseAll();
    await untilAllHandled(project, clock);

    expect([catalog(project, "sv"), catalog(project, "fi")]).toEqual([
      expect.stringContaining(`msgid "Hello"`),
      "(missing)",
    ]);
    await untilSynced(project, "src/later.tsx", "Later", "messages/sv.po");
  });

  // Unit under test: what the dev plugin sends open tabs while it follows a config edit: every catalog notice the
  // browser channel receives, a PO save's included. Oracle: the reload contract, by hand: a tab told reloads its
  // catalogs, so nothing goes out until the new config's watch has written them, not even for the old watch's last PO
  // write (its sync of a source save is held across the edit, and released, while the new watch's first sync is held,
  // until Vite has handled that write's report, made through Vite's watcher); then one notice, the config's, sent when
  // `sv.po` existed.
  it("tells open tabs about a config edit once the new watch has synced, and nothing before", async ({
    project,
  }) => {
    // The old watch's sync of the source save below (call 1), and the first sync of the `sv` config.
    const gate = syncGate((config, call) => call === 1 || config.locales.includes("sv"));
    const clock = configClock();
    const infos: Array<string> = [];
    // At each report of `nb.po` Vite handled: whether the PO held the saved source's message.
    const nbHandled: Array<boolean> = [];
    const server = await gatedServer(
      project,
      gate,
      [
        clock.plugin,
        {
          name: "nb-clock",
          enforce: "post",
          hotUpdate({ file }) {
            if (this.environment.name === "client" && file.endsWith("/messages/nb.po")) {
              nbHandled.push(catalog(project, "nb").includes(`msgid "New"`));
            }
          },
        },
      ],
      {
        customLogger: {
          ...createLogger("silent"),
          info: (message) => {
            infos.push(message);
          },
        },
      }
    );
    // Every catalog notice: what it names, and whether `sv.po` existed then.
    const notices: Array<{ readonly data: string; readonly sv: boolean }> = [];
    const { hot } = server.environments.client;
    const send = hot.send.bind(hot);
    hot.send = (payload: HotPayload) => {
      if (payload.type === "custom" && payload.event === CATALOG_UPDATE_EVENT) {
        notices.push({ data: JSON.stringify(payload.data), sv: existsSync(project.path("messages/sv.po")) });
      }
      send(payload);
    };
    await untilSourceHeld(project, gate);

    // Once the restart is logged, the follow is closing the old watch, which waits for its held sync.
    await savedOnce(project, clock, JSON.stringify(SV_CONFIG));
    await expect
      .poll(() => infos.some((info) => info.includes("restarting the catalog watch")), project.guard())
      .toBe(true);
    gate.release(0);
    await expect.poll(() => gate.entered(1), project.guard()).toBe(true);
    // The old watch's write of `nb.po`, reported here rather than awaited from the poll watcher, which may not have
    // taken the PO's baseline: emitted on Vite's watcher as chokidar emits it.
    server.watcher.emit("change", project.path("messages/nb.po"));
    await expect.poll(() => nbHandled.includes(true), project.guard()).toBe(true);
    const whileHeld = [...notices];

    gate.release(1);
    await untilAllHandled(project, clock);

    // The plugin names the config as Vite resolves it, through links.
    const config = JSON.stringify({ file: realpathSync(project.path("elmera-intl.json")) });
    expect({
      whileHeld,
      first: notices[0],
      told: notices.filter(({ data }) => data === config).length,
    }).toEqual({ whileHeld: [], first: { data: config, sv: true }, told: 1 });
  });

  // Unit under test: the dev server's start when its config is edited during the start's first sync (held), and the
  // new watch's first sync is held in turn. Oracle: the start contract, by hand: `createServer` resolves once the watch
  // the config selects by then has synced, so a plugin that configures the server after `intl()` finds `sv.po`; and
  // none has configured it while the new watch's sync is held.
  it("finishes starting once the watch on a config edited during its start has synced", async ({
    project,
  }) => {
    // The server's start sync (call 0), and the first sync of the edited config.
    const gate = syncGate((config, call) => call === 0 || config.locales.includes("sv"));
    const clock = configClock();
    // Whether `sv.po` existed when the next plugin configured the server.
    let configured: boolean | undefined;
    // The server, before its start resolves: its watcher is up before any plugin configures it.
    let starting: ViteDevServer | undefined;
    const opening = createServer({
      root: project.root,
      configFile: false,
      logLevel: "silent",
      server: SERVER_WATCH,
      plugins: [
        {
          name: "captures-the-server",
          configureServer(created) {
            starting = created;
          },
        },
        ...intlPlugins({}, gate.services.layer),
        clock.plugin,
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
      const server = await opening.catch(() => undefined);
      await server?.close();
    });
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);
    // The follow waits to close the start's watch until its held sync runs, so the edit is saved once Vite watches it.
    await expect
      .poll(
        () => starting !== undefined && watchedBy(starting, project.path("elmera-intl.json")),
        project.guard()
      )
      .toBe(true);
    await savedOnce(project, clock, JSON.stringify(SV_CONFIG));
    gate.release(0);
    // The new watch's first sync, its config naming `sv`; or, with nothing following the config, Vite having handled
    // the save, which waits for a follow.
    await expect
      .poll(() => gate.entered(1) || clock.handled() === clock.reported(), project.guard())
      .toBe(true);
    expect(gate.entered(1)).toBe(true);
    const whileHeld = configured;

    gate.release(1);
    await project.within(opening, "the start");

    expect({ whileHeld, configured }).toEqual({ whileHeld: undefined, configured: true });
  });

  // Unit under test: the dev server's start when its first watch fails to start on its own (its sources' tree refused
  // as it opens, the catalogs' tree already open), and its config is edited while that failed start's cleanup is held
  // (a host watcher that closes asynchronously). The watch uses native events, through a fake that opens the trees (a
  // polled watch opens none); Vite's watcher ignores the config, whose report is made through the server's plugin
  // container. Oracle: the start contract, by hand: `createServer` settles from the watch selected once every follow
  // scheduled by then has run, so it resolves, on the edited config's watch, which has written `sv.po`; the refused
  // start's failure is not the selected watch's.
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
    const config = join(root, "elmera-intl.json");
    const infos: Array<string> = [];
    let starting: ViteDevServer | undefined;
    const opening = createServer({
      root: project.root,
      configFile: false,
      logLevel: "silent",
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          infos.push(message);
        },
      },
      server: { watch: { ignored: (file: string) => file === config } },
      plugins: [
        {
          name: "captures-the-server",
          configureServer(created) {
            starting = created;
          },
        },
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
      const server = await opening.catch(() => undefined);
      await server?.close();
    });
    await project.within(cleanup.promise, "the failed start's cleanup");
    save(project, JSON.stringify(SV_CONFIG))();
    const reported = starting?.environments.client.pluginContainer.watchChange(config, { event: "update" });
    // Once the restart is logged, the follow is closing the failed watch, which waits for its cleanup.
    await expect
      .poll(() => infos.some((info) => info.includes("restarting the catalog watch")), project.guard())
      .toBe(true);
    held.resolve();

    expect([await project.within(outcome, "the start"), catalog(project, "sv")]).toEqual([
      "started",
      expect.stringContaining(`msgid "Hello"`),
    ]);
    await project.within(Promise.resolve(reported), "the report");
  });

  // Unit under test: the dev plugin's follow when the new watch fails to start (its logger throws on the first sync's
  // result, and on that sync's SyncFailed), then the config is edited again. Oracle: the follow contract, by hand: the
  // failed start is logged, tells open tabs nothing and leaves no watch, and the next edit starts one, so open tabs are
  // told once, and a message saved after it reaches `sv.po`.
  it("follows a config edit after a follow whose watch failed to start", async ({ project }) => {
    let failing = true;
    const errors: Array<string> = [];
    const clock = configClock();
    const server = await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          if (failing && message.includes("wrote messages/sv.po")) {
            throw new Error("logger gone");
          }
        },
        error: (message) => {
          if (failing && message.startsWith("SyncFailed:")) {
            throw new Error("logger gone");
          }

          errors.push(message);
        },
      },
      server: SERVER_WATCH,
      plugins: [intl(), clock.plugin],
    });
    const told = toldConfig(server);

    await untilHandled(project, clock, save(project, JSON.stringify(SV_CONFIG)));
    expect([errors, told()]).toEqual([
      [expect.stringContaining("the catalog watch did not start: logger gone")],
      0,
    ]);

    failing = false;
    await untilHandled(project, clock, save(project, JSON.stringify(SV_CONFIG, null, 2)));
    expect(told()).toBe(1);
    await untilSynced(project, "src/new.tsx", "New", "messages/sv.po");
  });

  // Unit under test: the dev plugin's follow when one step of it throws: the logger on the restart line, or the hot
  // channel on the notice to open tabs. Oracle: the follow contract, by hand: each step reports its own failure and
  // the next save is followed all the same, so once Vite has handled it, the `fi` config's watch has written `fi.po`.
  it.for([
    { fails: "the logger", logger: true },
    { fails: "the hot channel", logger: false },
  ])("follows the next save after a follow where $fails threw", async ({ logger }, { project }) => {
    let failing = true;
    const errors: Array<string> = [];
    const clock = configClock();
    const server = await devServer(project, {
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          if (logger && failing && message.includes("restarting the catalog watch")) {
            failing = false;
            throw new Error("logger gone");
          }
        },
        error: (message) => {
          errors.push(message);
        },
      },
      server: SERVER_WATCH,
      plugins: [intl(), clock.plugin],
    });
    const { hot } = server.environments.client;
    const send = hot.send.bind(hot);
    hot.send = (payload: HotPayload) => {
      if (!logger && failing && payload.type === "custom" && payload.event === CATALOG_UPDATE_EVENT) {
        failing = false;
        throw new Error("channel gone");
      }
      send(payload);
    };

    await untilHandled(project, clock, save(project, JSON.stringify(SV_CONFIG)));
    await untilHandled(project, clock, save(project, JSON.stringify(FI_CONFIG)));

    expect([
      failing,
      errors.filter((error) => error.includes("gone")).length,
      catalog(project, "fi"),
    ]).toEqual([false, 1, expect.stringContaining(`msgid "Hello"`)]);
  });

  // Unit under test: the dev plugin on a config link repointed to another target outside the root with the same text
  // (a deploy swapping versions), under chokidar's `followSymlinks: false`. Oracle: Vite's watcher reports only what
  // it watches (its root, and what a plugin adds), so the plugin adds the new target, at the watcher's boundary, when
  // the repoint is reported; and a later edit of that target, adding `sv`, is followed: `sv.po` gets the project's
  // message.
  it("follows edits of the target a config link is repointed to with the same text", async ({ project }) => {
    const outside = outsideRoot(project);
    const old = join(outside, "old", "elmera-intl.json");
    const next = join(outside, "next", "elmera-intl.json");
    [old, next].forEach((target) => {
      mkdirSync(dirname(target));
      writeFileSync(target, project.read("elmera-intl.json"));
    });
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(old, project.path("elmera-intl.json"));
    const clock = configClock();
    const adds = watcherAdds();
    await devServer(project, {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [adds.plugin, intl(), clock.plugin],
    });

    // Reported as the link changed or created.
    await untilHandled(project, clock, () => {
      applyEdit({ _tag: "Link", file: project.path("elmera-intl.json"), target: next });
    });
    expect(adds.added()).toContain(realpathSync(next));

    await untilHandled(project, clock, () => {
      writeFileSync(next, JSON.stringify(SV_CONFIG));
    });
    expect(catalog(project, "sv")).toContain(`msgid "Hello"`);
  });

  // Unit under test: the dev plugin on a config link that the Vite config imports, whose target outside the root
  // Vite records as its config's dependency (canonical) and watches. An edit of the target can be reported twice, as
  // the target and as the link (seen in review on a polled host); both reports are made here, right after the edit,
  // so the link's reaches the server Vite is about to replace. Oracle: Vite's restart contract: it restarts the server
  // for a change it reports at a dependency of its config, and the replacement reads the config itself; so the plugin
  // restarts no watch for either report, and Vite's restart is the only one.
  it("leaves a linked config that the Vite config imports to Vite's restart", async ({ project }) => {
    const target = join(outsideRoot(project), "prev.json");
    writeFileSync(target, project.read("elmera-intl.json"));
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(target, project.path("elmera-intl.json"));
    project.write(
      "vite.config.mjs",
      `import config from "./elmera-intl.json" with { type: "json" };\nexport default { define: { LOCALES: JSON.stringify(config.locales) } };\n`
    );
    const infos: Array<string> = [];
    const server = await devServer(project, {
      configFile: project.path("vite.config.mjs"),
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          infos.push(message);
        },
      },
      server: SERVER_WATCH,
      plugins: [intl()],
    });
    expect(server.config.configFileDependencies).toContain(realpathSync(target));

    // Both reports of the edit, made here rather than awaited from the poll watcher, which may not have taken the
    // target's baseline yet: the target's, at its canonical path, emitted on Vite's watcher as chokidar emits it (Vite
    // restarts the server for it), then the link's, through the server's plugin container.
    writeFileSync(target, JSON.stringify(SV_CONFIG));
    server.watcher.emit("change", realpathSync(target));
    await server.environments.client.pluginContainer.watchChange(
      join(realpathSync(project.root), "elmera-intl.json"),
      { event: "update" }
    );
    await expect
      .poll(() => infos.some((info) => info.includes("server restarted")), project.guard())
      .toBe(true);

    expect(infos.filter((info) => info.includes("restarting the catalog watch"))).toEqual([]);
  });

  // Unit under test: the dev plugin on a config link repointed to another target the Vite config imports, when the
  // link itself is no dependency of the Vite config. Oracle: Vite's restart contract: Vite restarts for a change it
  // reports at a dependency of its config, and it reports the repoint at the link's path, which is none, so no restart
  // follows; the plugin follows the repoint itself: it restarts its watch, and the new target's `sv` gets the project's
  // message.
  it("follows a config link repointed to another target the Vite config imports", async ({ project }) => {
    const outside = outsideRoot(project);
    const old = join(outside, "old.json");
    const next = join(outside, "next.json");
    writeFileSync(old, project.read("elmera-intl.json"));
    writeFileSync(next, JSON.stringify(SV_CONFIG));
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(old, project.path("elmera-intl.json"));
    project.write(
      "vite.config.mjs",
      `import config from "./elmera-intl.json" with { type: "json" };\nimport next from ${JSON.stringify(next)} with { type: "json" };\nexport default { define: { LOCALES: JSON.stringify([config.locales, next.locales]) } };\n`
    );
    const infos: Array<string> = [];
    const clock = configClock();
    const server = await devServer(project, {
      configFile: project.path("vite.config.mjs"),
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          infos.push(message);
        },
      },
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [intl(), clock.plugin],
    });
    expect(server.config.configFileDependencies).toEqual(
      expect.arrayContaining([realpathSync(old), realpathSync(next)])
    );

    // Reported as the link changed or created.
    await untilHandled(project, clock, () => {
      applyEdit({ _tag: "Link", file: project.path("elmera-intl.json"), target: next });
    });

    expect([
      infos.some((info) => info.includes("restarting the catalog watch")),
      catalog(project, "sv"),
    ]).toEqual([true, expect.stringContaining(`msgid "Hello"`)]);
  });

  // Unit under test: the dev plugin on a config that is, from the start, a link to a target outside the Vite root,
  // under chokidar's `followSymlinks: false`. Oracle: Vite's watcher reports only what it watches (its root, and what a
  // plugin adds), so the plugin adds the target, at the watcher's boundary, as the server starts; and an edit of the
  // target, adding `sv`, is followed: `sv.po` gets the project's message.
  it("follows edits of a config link's target outside the Vite root from the start", async ({ project }) => {
    const target = join(outsideRoot(project), "elmera-intl.json");
    writeFileSync(target, project.read("elmera-intl.json"));
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(target, project.path("elmera-intl.json"));
    const adds = watcherAdds();
    await devServer(project, {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [adds.plugin, intl()],
    });
    expect(adds.added()).toContain(realpathSync(target));

    // Written again each probe interval until the watch on it has synced: the add's own report can come first.
    await expect
      .poll(
        () => {
          writeFileSync(target, JSON.stringify(SV_CONFIG));

          return catalog(project, "sv");
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toContain(`msgid "Hello"`);
  });

  // Unit under test: the dev server's close while a follow is starting a watch (its first sync held) and a repoint of
  // the config link is queued behind it; both reports made through the server's plugin container. Oracle: the close
  // contract, by hand: a follow queued before the close does nothing, so once the close settles no path was added to
  // Vite's watcher after the close began, and no watch started on the repointed config (no `fi.po`). The hold is
  // released once the plugin's close has begun.
  it("registers nothing with the watcher for a follow queued before the dev server closes", async ({
    project,
  }) => {
    const outside = outsideRoot(project);
    const old = join(outside, "old.json");
    const next = join(outside, "next.json");
    writeFileSync(old, project.read("elmera-intl.json"));
    writeFileSync(next, JSON.stringify(FI_CONFIG));
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(old, project.path("elmera-intl.json"));
    const gate = syncGate();
    const clock = configClock();
    const adds = watcherAdds();
    const server = await gatedServer(project, gate, [adds.plugin, clock.plugin], {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
    });
    const report = () =>
      server.environments.client.pluginContainer.watchChange(
        join(realpathSync(project.root), "elmera-intl.json"),
        { event: "update" }
      );

    writeFileSync(old, JSON.stringify(SV_CONFIG));
    const first = report();
    await expect.poll(() => gate.entered(0), project.guard()).toBe(true);
    applyEdit({ _tag: "Link", file: project.path("elmera-intl.json"), target: next });
    const second = report();
    const closing = server.close();
    await expect.poll(() => clock.closing(), project.guard()).toBe(true);
    const before = adds.added().length;
    gate.release(0);
    await project.within(Promise.all([closing, first, second]), "the close");

    expect([adds.added().slice(before), catalog(project, "fi")]).toEqual([[], "(missing)"]);
  });

  // Unit under test: the dev plugin on a config outside the Vite root that is a link, under chokidar's
  // `followSymlinks: false`, which reports a link it is asked to watch as created (#52). Oracle: the follow contract,
  // by hand: only a change to the config's text restarts the watch, and watching the link changes none, so once Vite
  // has handled that report, the plugin has logged no restart.
  it("restarts no watch on a report that leaves its config's text as it was", async ({ project }) => {
    const outside = outsideRoot(project);
    writeFileSync(join(outside, "elmera-intl.json"), project.read("elmera-intl.json"));
    rmSync(project.path("elmera-intl.json"));
    symlinkSync(join(outside, "elmera-intl.json"), project.path("elmera-intl.json"));
    mkdirSync(project.path("app"));
    const infos: Array<string> = [];
    const clock = configClock();
    await devServer(project, {
      root: project.path("app"),
      customLogger: {
        ...createLogger("silent"),
        info: (message) => {
          infos.push(message);
        },
      },
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [intl({ config: "../elmera-intl.json" }), clock.plugin],
    });

    await expect
      .poll(() => clock.reported() > 0 && clock.handled() === clock.reported(), project.guard())
      .toBe(true);
    expect(infos.filter((info) => info.includes("restarting the catalog watch"))).toEqual([]);
  });

  // Unit under test: a PO import across a repoint of the config symlink to another config, during dev (#52's comment).
  // Oracle: Intl rejects the currency "NOKK", which only the repointed config's formats module makes reachable. The
  // watcher reports the repoint as the link created, under its own path, with chokidar's `followSymlinks: false`, and
  // Vite invalidates no module for a file created; once Vite has handled it, the next load compiles with the new
  // target.
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
    const clock = configClock();
    const server = await devServer(project, {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
      plugins: [intl(), clock.plugin],
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

    await untilHandled(project, clock, () => {
      applyEdit({
        _tag: "Link",
        file: project.path("elmera-intl.json"),
        target: join(outside, "invalid.json"),
      });
    });

    await expect(load()).resolves.toMatch(/Invalid currency code : NOKK/u);
  });
  // Unit under test: a PO import loaded while a follow of a config symlink repoint is starting the new watch, its first
  // sync held. Oracle: Intl rejects the currency "NOKK", which only the repointed config's formats module makes
  // reachable. Vite invalidates no module for a link it reports as created (`followSymlinks: false`), so the plugin
  // invalidates the compiled catalogs when it restarts the watch, before the new watch has synced: a load in between
  // compiles with the config as it is.
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
    const clock = configClock();
    const server = await gatedServer(project, gate, [clock.plugin], {
      server: { watch: { ...SERVER_WATCH.watch, followSymlinks: false } },
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

    await untilHeld(project, clock, gate, 0, () => {
      applyEdit({
        _tag: "Link",
        file: project.path("elmera-intl.json"),
        target: join(outside, "invalid.json"),
      });
    });

    await expect(load()).resolves.toMatch(/Invalid currency code : NOKK/u);
  });
});
