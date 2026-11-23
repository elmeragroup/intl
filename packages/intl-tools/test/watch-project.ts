import { makeMethods, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdirSync } from "node:fs";

import type { ExtractOptions, ExtractResult } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import { loadConfig } from "../src/project-config";
import type { WatchMode } from "../src/watch";
import { CatalogSync } from "../src/watch";
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
 * The watch's sync step as `extract`, which runs inside one synchronous call, so a test can save between a sync's read
 * and its writes.
 *
 * @param extract - The sync step.
 * @returns A `CatalogSync` layer running it.
 */
export function syncing(
  extract: (config: ProjectConfig, options: ExtractOptions) => ExtractResult
): Layer.Layer<CatalogSync> {
  return Layer.succeed(CatalogSync, {
    extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
      return yield* Effect.sync(() => extract(config, options));
    }),
  });
}

/** File events a test delivers itself: the listener of each tree the watch has open. */
export type DeliveredEvents = {
  /** The `FileEvents` the watch listens through. */
  readonly layer: Layer.Layer<FileEvents>;
  /** The trees the watch is listening to now, in the order it opened them. */
  readonly open: () => ReadonlyArray<string>;
  /** How many trees the watch has begun to open (and not yet opened, when `opening` holds them). */
  readonly opening: () => number;
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
  /** Each tree opens only once this settles, as a host's watcher that opens asynchronously. */
  readonly opening?: Promise<void>;
  /** Each tree's close dies with this, as a watcher that fails to close. */
  readonly closeFails?: Error;
};

/**
 * A `FileEvents` fake: it records each listener while its scope is open, and a test delivers events through it.
 *
 * @param options - How its trees open and close.
 * @returns The fake.
 */
export function deliveredEvents(options: DeliveredEventsOptions = {}): DeliveredEvents {
  const listeners = new Map<string, TreeListener>();
  let opening = 0;

  return {
    layer: Layer.succeed(FileEvents, {
      watch: Effect.fn("DeliveredEvents.watch")(function* (dir: string, listener: TreeListener) {
        opening += 1;

        if (options.opening !== undefined) {
          const opened = options.opening;
          yield* Effect.promise(() => opened);
        }

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            listeners.set(dir, listener);
          }),
          () =>
            Effect.suspend(() => {
              listeners.delete(dir);

              return options.closeFails === undefined ? Effect.void : Effect.die(options.closeFails);
            })
        );
      }),
    }),
    open: () => [...listeners.keys()],
    opening: () => opening - listeners.size,
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
