import { makeMethods, test } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { mkdirSync } from "node:fs";

import type { ProjectIoFailed } from "../src/catalog-files";
import { CatalogFiles, ioFailureReason } from "../src/catalog-files";
import type { ExtractOptions, ExtractResult } from "../src/commands";
import { SourceCaches } from "../src/project";
import type { ProjectConfig } from "../src/project-config";
import { loadConfig } from "../src/project-config";
import { ProjectFormats } from "../src/project-formats-service";
import type { ProjectServices } from "../src/project-services";
import { projectServices } from "../src/project-services";
import type { SyncResult, SyncServices, Watching, WatchMode, WatchOutput, WatchServices } from "../src/watch";
import { CatalogSync, SyncFailed, watchCatalogs } from "../src/watch";
import type { TreeListener } from "../src/watch-trees";
import { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";
import { SYNC_FILE_SYSTEM } from "./sync-file-system";

// The watch tests' shared project and helpers: the executable's and in-process watches (`watch.test.ts`,
// `watch-lifecycle.test.ts`), and the watch on the test clock: its timing (`watch-clock.test.ts`) and the saves it keeps
// (`watch-saves.test.ts`).

/** The watched project's config: every source under `src`, one Norwegian catalog. */
export const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
/** The runtime import every source starts with. */
export const IMPORT = `import { T } from "@elmeragroup/intl/react";\n`;

// Every watch here polls: a stat of each watched file every 50 ms sees an edit whatever the host's file events do
// (macOS delivers them through fseventsd, which a busy host delays by seconds or drops), so each wait ends on the edit,
// not on the event daemon. `--poll` and `watchProject`'s mode are the same seam the CLI and the Vite plugin expose to
// such hosts; the native events stay the default, and the e2e dev loop and the native cases run on them.

/** The poll interval, as the CLI takes it. */
export const POLL_MS = "50";
/** The poll interval, as a watch mode. */
export const POLLING: WatchMode = { _tag: "poll", intervalMs: Number(POLL_MS) };

/**
 * A source file with one message.
 *
 * @param text - The message.
 * @returns The file's text.
 */
export function component(text: string): string {
  return `${IMPORT}export const C = () => <T>${text}</T>;\n`;
}

/**
 * The watch tests' `it`: each test owns its project (see `Project`), seeded with the config and one source. Every
 * helper takes the project, and no test reads a shared root after an await, so one that overruns cannot touch the next
 * test's files. Every wait ends by the project's deadline.
 */
export const it = makeMethods(
  test.extend("project", ({ task }, { onCleanup }) => {
    const { project, close } = openProject("elmera-intl-watch-", task.timeout);
    onCleanup(close);
    project.write("elmera-intl.json", JSON.stringify(CONFIG));
    project.write("src/page.tsx", component("Hello"));

    return project;
  })
);

/**
 * The project's config, as the watch reads it.
 *
 * @param project - The project.
 * @returns The parsed config.
 * @throws The config's problem, when the test wrote an invalid one.
 */
export function projectConfig(project: Project): ProjectConfig {
  const loaded = loadConfig(project.path("elmera-intl.json"));

  if (loaded._tag !== "Config") {
    throw new Error(loaded.problem.message);
  }

  return loaded.config;
}

/**
 * A host's runtime for `watchProject`, as the Vite plugin makes one: `extractCatalogs` on the project's services on
 * Node and Node's file events, disposed when the test ends (after every cleanup registered later, such as a watch's
 * close).
 *
 * @param project - The project whose teardown disposes it.
 * @param events - The file events it provides; Node's unless a test delivers its own.
 * @param sync - The sync's extract it provides; `extractCatalogs` unless a test holds it.
 * @returns The runtime.
 */
export function hostRuntime(
  project: Project,
  events: Layer.Layer<FileEvents> = FileEvents.layer(),
  sync: Layer.Layer<CatalogSync, never, SyncServices> = CatalogSync.layer()
): ManagedRuntime.ManagedRuntime<WatchServices, never> {
  const runtime = ManagedRuntime.make(Layer.mergeAll(Layer.provide(sync, projectServices()), events));
  project.defer(() => runtime.dispose());

  return runtime;
}

/**
 * The services a host provides a CLI program: the project's services on Node, and the sync's extract on them.
 *
 * @param sync - The sync's extract; `extractCatalogs` unless a test holds it.
 * @returns A layer providing both.
 */
export function catalogServices(
  sync: Layer.Layer<CatalogSync, never, SyncServices> = CatalogSync.layer()
): Layer.Layer<CatalogSync | ProjectServices> {
  return Layer.provideMerge(sync, projectServices());
}

/**
 * `catalogServices` built synchronously, on the synchronous file system (`SYNC_FILE_SYSTEM`) with no formats evaluator
 * (a watch never evaluates one): a program forked on it runs up to its first suspension of its own, as when every read
 * was synchronous. Node's services import the platform as they are built, a suspension before the program starts.
 *
 * @returns A layer providing the sync's extract and the commands' services, the paths left to the host's platform.
 */
export function syncCatalogServices(): Layer.Layer<
  CatalogSync | CatalogFiles | SourceCaches | ProjectFormats | FileSystem.FileSystem
> {
  return Layer.provideMerge(
    CatalogSync.layer(),
    Layer.mergeAll(
      CatalogFiles.layer(),
      SourceCaches.layer,
      ProjectFormats.layer(Effect.die("a watch evaluates no formats module"))
    ).pipe(Layer.provideMerge(SYNC_FILE_SYSTEM))
  );
}

/**
 * A failure of the commands' I/O as the watch's `CatalogSync` reports it, for a test's own sync step.
 *
 * @param failure - The failure.
 * @returns The `SyncFailed` naming its reason.
 */
export function asSyncFailed(failure: ProjectIoFailed): SyncFailed {
  return new SyncFailed({ message: ioFailureReason(failure) });
}

/**
 * The watch's sync step as `extract`, an effect a test can save in between a sync's read and its writes, or hold. It
 * runs on the host's services, as `CatalogSync.layer()` does.
 *
 * @param extract - The sync step.
 * @returns A `CatalogSync` layer running it.
 */
export function syncing(
  extract: (
    config: ProjectConfig,
    options: ExtractOptions
  ) => Effect.Effect<ExtractResult, ProjectIoFailed, SyncServices>
): Layer.Layer<CatalogSync, never, SyncServices> {
  return Layer.effect(
    CatalogSync,
    Effect.gen(function* () {
      const services = yield* Effect.context<SyncServices>();

      return {
        extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
          return yield* extract(config, options).pipe(
            Effect.provideContext(services),
            Effect.mapError(asSyncFailed)
          );
        }),
      };
    })
  );
}

/** A watch a test started on the test clock (see `launchWatch`). */
export type ClockedWatch = {
  /** The tag of each result the watch reported, in order, unless the test writes them itself. */
  readonly reports: Array<SyncResult["_tag"]>;
  readonly stop: Deferred.Deferred<void>;
  /** The watch's own scope, inside the test's. */
  readonly scope: Scope.Closeable;
  readonly watching: Watching;
};

/**
 * Start `effect` from a sleep the test clock wakes, so the clock waits until everything it sets off (the classifying of
 * a backlog, a sync) has suspended before it moves on.
 *
 * @template A - What `effect` returns.
 * @template E - How `effect` fails.
 * @param effect - The effect to start.
 * @returns The fiber that finishes it.
 */
export const wake = /* @__PURE__ */ Effect.fnUntraced(function* <A, E>(effect: Effect.Effect<A, E>) {
  // oxlint-disable-next-line tests/no-fixed-delay -- a test-clock sleep, woken by the TestClock.adjust below: no real time passes.
  const running = yield* Effect.sleep("1 millis").pipe(Effect.andThen(effect), Effect.forkChild);
  yield* TestClock.adjust("1 millis");

  return running;
});

/**
 * Run `effect` from a test-clock wake (see `wake`).
 *
 * @template A - What `effect` returns.
 * @param effect - The effect to run.
 * @returns What it returns.
 */
export const woken = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
  wake(effect).pipe(Effect.flatMap((fiber) => Fiber.join(fiber)));

/** How `launchWatch` starts a watch. */
export type ClockedWatchOptions = {
  /** The sync step; `CatalogSync.layer()` unless a test holds or changes it. */
  readonly layer?: Layer.Layer<CatalogSync, never, SyncServices>;
  /** The catalog files the sync reads and writes; Node's unless a test stands between a sync's reads and writes. */
  readonly files?: Layer.Layer<CatalogFiles, never, FileSystem.FileSystem>;
  /** Writes each result; records its tag unless a test writes it. */
  readonly report?: (result: SyncResult) => Effect.Effect<void>;
  /** The watch's clock; the test clock unless a test moves the wall clock alone. */
  readonly clock?: Clock.Clock;
  /** Where change events come from; the poll unless a test delivers native events itself. */
  readonly mode?: WatchMode;
  /** The native file events; Node's unless a test delivers them itself. */
  readonly events?: Layer.Layer<FileEvents>;
  /** How the watch's caller scope runs its finalizers; sequential unless a test closes it in parallel. */
  readonly strategy?: "sequential" | "parallel";
  /** The stop signal; a new one unless a test gives it before the watch starts or as its trees open. */
  readonly stop?: Deferred.Deferred<void>;
};

/**
 * Start the watch in a scope of its own inside the test's, with its sync step built in that scope so it lives as long
 * as the watch. It starts from a test-clock wake, so its poll and its debounce time from 1 ms. Its reads are Node's
 * synchronous ones (`SYNC_FILE_SYSTEM`), so each sync completes within the clock's move.
 *
 * @param project - The watched project.
 * @param options - What the test changes about the watch.
 * @returns Once the start has run up to its first suspension (a held first sync), the run, with the fiber that
 *   finishes the start.
 */
export const launchWatch = /* @__PURE__ */ Effect.fnUntraced(function* (
  project: Project,
  options: ClockedWatchOptions = {}
) {
  const reports: Array<SyncResult["_tag"]> = [];
  const scope = yield* Scope.fork(yield* Effect.scope, options.strategy ?? "sequential");
  const stop = options.stop ?? (yield* Deferred.make<void>());
  const services = yield* Layer.buildWithScope(
    Layer.merge(
      Layer.provide(
        options.layer ?? CatalogSync.layer(),
        Layer.mergeAll(options.files ?? CatalogFiles.layer(), SourceCaches.layer).pipe(
          Layer.provideMerge(SYNC_FILE_SYSTEM)
        )
      ),
      options.events ?? FileEvents.layer()
    ),
    scope
  );
  const output: WatchOutput<never> = {
    report:
      options.report ??
      ((result) =>
        Effect.sync(() => {
          reports.push(result._tag);
        })),
    ready: Effect.void,
  };
  const starting = watchCatalogs(projectConfig(project), options.mode ?? POLLING, stop, output).pipe(
    Scope.provide(scope),
    Effect.provideContext(services)
  );
  const clocked =
    options.clock === undefined ? starting : starting.pipe(Effect.provideService(Clock.Clock, options.clock));
  const watching = yield* wake(clocked);

  return { reports, stop, scope, watching };
});

/**
 * Start the watch (see `launchWatch`) and wait for its start.
 *
 * @param project - The watched project.
 * @param options - What the test changes about the watch.
 * @returns The started watch.
 */
export const startWatch = /* @__PURE__ */ Effect.fnUntraced(function* (
  project: Project,
  options: ClockedWatchOptions = {}
) {
  const { watching, ...run } = yield* launchWatch(project, options);

  return { ...run, watching: yield* Fiber.join(watching) } satisfies ClockedWatch;
});

/** File events a test delivers itself: the listener of each tree the watch has open. */
export type DeliveredEvents = {
  /** The `FileEvents` the watch listens through. */
  readonly layer: Layer.Layer<FileEvents>;
  /** The trees the watch is listening to now, in the order it opened them. */
  readonly open: () => ReadonlyArray<string>;
  /** How many trees the watch has begun to open (and not yet opened, when `opening` or `acquiring` holds them). */
  readonly opening: () => number;
  /** How many times the watch has called `FileEvents.watch`. */
  readonly calls: () => number;
  /**
   * The listener of an open tree, to deliver an event or an error to.
   *
   * @param dir - The tree.
   * @returns Its listener.
   * @throws When the watch is not listening to `dir`.
   */
  readonly listener: (dir: string) => TreeListener;
};

/** How a `deliveredEvents` fake opens and closes. */
export type DeliveredEventsOptions = {
  /**
   * What a tree waits for before it opens, as a host's watcher that opens asynchronously; the wait can be interrupted.
   * Undefined for a tree that opens at once.
   */
  readonly opening?: (dir: string) => Promise<void> | undefined;
  /** What each tree's watcher waits for while it is acquired, so the wait cannot be interrupted. */
  readonly acquiring?: Promise<void>;
  /** Called as each tree opens, synchronously, once its listener is recorded. */
  readonly opened?: (dir: string) => void;
  /** A tree whose watch fails as it starts, dying with this error, as a recursive watch of an unreadable one does. */
  readonly refuses?: { readonly dir: string; readonly error: Error };
  /** Each tree's close dies with this, as a watcher that fails to close. */
  readonly closeFails?: Error;
  /** What each tree's close waits for before it closes, as a host watcher that closes asynchronously; called as it begins. */
  readonly releasing?: (dir: string) => Promise<void>;
};

/**
 * A `FileEvents` fake: it records each listener while its scope is open, and a test delivers events through it.
 *
 * @param options - How its trees open and close.
 * @returns The fake.
 */
export function deliveredEvents(options: DeliveredEventsOptions = {}): DeliveredEvents {
  const listeners = new Map<string, TreeListener>();
  let calls = 0;

  return {
    layer: Layer.succeed(FileEvents, {
      watch: Effect.fn("DeliveredEvents.watch")(function* (dir: string, listener: TreeListener) {
        calls += 1;
        const opening = options.opening?.(dir);

        if (opening !== undefined) {
          yield* Effect.promise(() => opening);
        }

        if (options.refuses?.dir === dir) {
          return yield* Effect.die(options.refuses.error);
        }

        const { acquiring } = options;
        yield* Effect.acquireRelease(
          (acquiring === undefined ? Effect.void : Effect.promise(() => acquiring)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                listeners.set(dir, listener);
                options.opened?.(dir);
              })
            )
          ),
          () =>
            Effect.promise(() => options.releasing?.(dir) ?? Promise.resolve()).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  listeners.delete(dir);

                  return options.closeFails === undefined ? Effect.void : Effect.die(options.closeFails);
                })
              )
            )
        );
      }),
    }),
    open: () => [...listeners.keys()],
    opening: () => calls - listeners.size,
    calls: () => calls,
    listener: (dir) => {
      const listener = listeners.get(dir);

      if (listener === undefined) {
        throw new Error(`the watch is not listening to ${dir}`);
      }

      return listener;
    },
  };
}

/**
 * The file watchers open in this process: one per native watch on macOS, one per watched directory on Linux.
 *
 * @returns Their count.
 */
export function watches(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap").length;
}

/**
 * A project with a third include root that cannot be read: `messages` and `src` are watched first, in order, then the
 * watch of `zz-locked` fails (on Linux, where a recursive watch of an unreadable directory fails as it starts).
 *
 * @param project - The project.
 */
export function lockedRoot(project: Project): void {
  project.write(
    "elmera-intl.json",
    JSON.stringify({ ...CONFIG, include: [...CONFIG.include, "zz-locked/**/*.tsx"] })
  );
  mkdirSync(project.path("messages"));
  project.lock("zz-locked");
}
