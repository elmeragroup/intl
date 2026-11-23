import { makeMethods, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { mkdirSync } from "node:fs";

import type { ProjectIoFailed } from "../src/catalog-files";
import { ioFailureReason } from "../src/catalog-files";
import type { ExtractOptions, ExtractResult } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import { loadConfig } from "../src/project-config";
import type { WatchMode, WatchServices } from "../src/watch";
import { CatalogSync, SyncFailed } from "../src/watch";
import type { TreeListener } from "../src/watch-trees";
import { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

// The watch tests' shared project and helpers: the executable's and in-process watches (`watch.test.ts`) and the
// watch's timing on the test clock (`watch-clock.test.ts`).

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
 * A host's runtime for `watchProject`, as the Vite plugin makes one: `extractCatalogs` and Node's file events,
 * disposed when the test ends (after every cleanup registered later, such as a watch's close).
 *
 * @param project - The project whose teardown disposes it.
 * @param events - The file events it provides; Node's unless a test delivers its own.
 * @param sync - The sync's extract it provides; `extractCatalogs` unless a test holds it.
 * @returns The runtime.
 */
export function hostRuntime(
  project: Project,
  events: Layer.Layer<FileEvents> = FileEvents.layer(),
  sync: Layer.Layer<CatalogSync> = CatalogSync.layer()
): ManagedRuntime.ManagedRuntime<WatchServices, never> {
  const runtime = ManagedRuntime.make(Layer.mergeAll(sync, events));
  project.defer(() => runtime.dispose());

  return runtime;
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
 * The watch's sync step as `extract`, an effect a test can save in between a sync's read and its writes, or hold.
 *
 * @param extract - The sync step.
 * @returns A `CatalogSync` layer running it.
 */
export function syncing(
  extract: (config: ProjectConfig, options: ExtractOptions) => Effect.Effect<ExtractResult, ProjectIoFailed>
): Layer.Layer<CatalogSync> {
  return Layer.succeed(CatalogSync, {
    extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
      return yield* extract(config, options).pipe(Effect.mapError(asSyncFailed));
    }),
  });
}

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
