import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import { existsSync } from "node:fs";

import { syncCatalogs } from "../src/catalog-sync";
import type { ProjectConfig } from "../src/project-config";
import type { WatchMode } from "../src/watch";
import type { Following } from "../src/watch-follow";
import type { Project } from "./project-fixture";
import { CONFIG, deliveredEvents, POLL_MS, syncing } from "./watch-project";

// The follow's tests' shared helpers, on top of `watch-project.ts`: its start (`watch-follow-start.test.ts`) and the
// edits it follows (`watch-follow.test.ts`).

/** The config's text as seeded. */
export const CONFIG_TEXT = JSON.stringify(CONFIG);
/** The config's text with one more locale. */
export const SV_TEXT = JSON.stringify({ ...CONFIG, locales: ["nb", "sv"] });
/** The config's text with another. */
export const FI_TEXT = JSON.stringify({ ...CONFIG, locales: ["nb", "fi"] });

/**
 * A locale's PO, as a sync wrote it; none when no sync has.
 *
 * @param project - The project.
 * @param locale - The locale.
 * @returns The catalog's text, or `"(missing)"`.
 */
export function catalog(project: Project, locale: string): string {
  const path = `messages/${locale}.po`;

  return existsSync(project.path(path)) ? project.read(path) : "(missing)";
}

/** How long the follow waits between reads of the config on native events (`CONFIG_READ_MS` in watch-follow.ts). */
export const CONFIG_READ = "250 millis" as const;

/**
 * Waits `duration` for the follow's next read of the config, then a few turns for the restart it may set off and its
 * writes: no other sleep is due within them.
 *
 * @param duration - How long until the next read.
 * @returns The wait.
 */
export const afterRead = /* @__PURE__ */ Effect.fnUntraced(function* (duration: Duration.Input) {
  yield* TestClock.adjust(duration);

  for (let turn = 0; turn < 3; turn += 1) {
    yield* TestClock.adjust("1 millis");
  }
});

/** The native file events, as a watch mode. */
export const NATIVE: WatchMode = { _tag: "native" };
/** The next read of the config on the poll, and a turn for the restart it may set off. */
export const nextRead = /* @__PURE__ */ afterRead(`${POLL_MS} millis`);

/**
 * The sync step: `syncCatalogs`, each sync whose config `gateFor` names a gate waiting for it before it reads.
 *
 * @param gateFor - The gate a sync on a config waits for, if any.
 * @returns The sync step's layer, and how many syncs it has held.
 */
export function holding(gateFor: (config: ProjectConfig) => Deferred.Deferred<void> | undefined) {
  let held = 0;
  const layer = syncing(
    Effect.fnUntraced(function* (config: ProjectConfig) {
      const gate = gateFor(config);

      if (gate !== undefined) {
        held += 1;
        yield* Deferred.await(gate);
      }

      return yield* syncCatalogs(config);
    })
  );

  return { layer, held: () => held };
}

/**
 * Two gates, each held until the test opens it, or `release` opens both: registered as a finalizer once the watch is
 * launched, it runs before the watch's close, so a failed assertion leaves no sync held for that close to wait for.
 *
 * @returns The gates, and `release`.
 */
export const gates = /* @__PURE__ */ Effect.fnUntraced(function* () {
  const first = yield* Deferred.make<void>();
  const second = yield* Deferred.make<void>();
  const release = Effect.addFinalizer(() =>
    Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.succeed(second, undefined)))
  );

  return { first, second, release };
});

/**
 * Waits for `effect`, failing at the project's deadline rather than hanging the test.
 *
 * @template A - What `effect` returns.
 * @param project - The project whose deadline bounds the wait.
 * @param effect - What the test waits for.
 * @param what - What it is, as a timeout names it.
 * @returns What `effect` returns.
 */
export const within = <A>(project: Project, effect: Effect.Effect<A>, what: string) =>
  Effect.promise(() => project.within(Effect.runPromise(effect), what));

/**
 * Who claims a stop is decided in one step: every fiber yields after each operation, so a claim made over two would
 * lose it.
 */
export const claimSensitive = /* @__PURE__ */ Effect.provideService(References.MaxOpsBeforeYield, 1);

/**
 * How a follow's start ended: the outcome it settled as, or the failure it ended with.
 *
 * @param start - The start's fiber.
 * @returns The outcome or the failure; undefined while it runs.
 */
export function outcome(start: Fiber.Fiber<Following>): string | undefined {
  const exit = start.pollUnsafe();

  if (exit === undefined) {
    return undefined;
  }

  return Exit.isSuccess(exit) ? exit.value._tag : String(Cause.squash(exit.cause));
}

/**
 * How an effect ended.
 *
 * @param effect - The effect.
 * @returns `"clean"`, or the failure it ended with.
 */
export const ending = (effect: Effect.Effect<void>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) ? "clean" : String(Cause.squash(exit.cause))))
  );

/**
 * The file events of a project whose catalogs' directory exists, so the watch opens two trees, the catalogs' first
 * (path order) and the sources' second, with the sources' tree as `opening` says.
 *
 * @param project - The project.
 * @param options - How its trees open and close.
 * @returns The file events.
 */
export function twoTrees(project: Project, options: Parameters<typeof deliveredEvents>[0] = {}) {
  project.write("messages/.keep", "");

  return deliveredEvents(options);
}

/**
 * A tree refused the first time it opens, as an unreadable directory's recursive watch fails.
 *
 * @param project - The project.
 * @param dir - The tree, relative to the root.
 * @returns An `opening` for `deliveredEvents`.
 */
export function refusedOnce(project: Project, dir: string) {
  let refused = false;

  return (opened: string) => {
    if (refused || opened !== project.path(dir)) {
      return undefined;
    }

    refused = true;

    return Promise.reject(new Error("EACCES: permission denied, watch"));
  };
}
