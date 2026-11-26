// A host's watch session outside an Effect program (the Vite dev server's): the followed watch (`followConfig`) on one
// fiber, its services provided around it, and the Promise handles the host holds. The session owns its services, its
// start, its stop and its end; the host keeps only the handle (#61).
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";

import type { SyncResult, WatchMode, WatchOutput, WatchServices } from "./watch";
import { writeResult } from "./watch";
import { followConfig } from "./watch-follow";

const NATIVE: WatchMode = { _tag: "native" };

/** A watch a host has started: its start, and its stop, which the host may ask for at any time, the start included. */
export type ProjectWatcher = {
  /**
   * Settles once the first sync's result is reported (or the config's problem is), or once a stop the host asked for
   * during the start has run. Otherwise rejects, after the session has ended and released its services, with the
   * services' failure to build, the start's failure (a first watch that failed to start, the first result's report
   * failure), or an Error saying the session ended before its first result.
   */
  readonly started: Promise<void>;
  /**
   * Stop watching, at once: the stop runs as `followConfig`'s does, and every result made is reported. Settles once
   * the session has ended, every watcher it opened closed and its services released; never rejects, and every call
   * shares the one shutdown. A failure that ends a started session goes to `onEnd`, never here.
   */
  readonly close: () => Promise<void>;
};

/** How a started session ended in failure: the failure, and whether a close was pending when it ended. */
export type ProjectWatchEnd = { readonly cause: unknown; readonly closing: boolean };

/**
 * Start a followed watch on the config at `configPath` outside an Effect program: `followConfig`, reading the config
 * itself, in a scope of its own on one fiber, with `services` provided around it and released when the fiber ends,
 * however it ends. The stop handle is the host's at once, so a host that closes during the start stops it there.
 *
 * Each ending has one reader. A start that fails (the services failing to build included, whatever stop came) rejects
 * `started`, and calls nothing. A session that ends in failure after its start (a stop during the start included)
 * calls `onEnd` once, before any close settles, with whether a close was pending, decided in the step the fiber
 * ends; one that throws is ignored. Nothing else is reported: `close` resolves.
 *
 * @param services - What the follow and its watches run on.
 * @param configPath - The project config's absolute path: an invalid or missing config is reported, and the watch
 *   starts once an edit fixes it.
 * @param report - Called with each result, in order; one that throws is called again with that result's `SyncFailed`.
 *   When that throws too, the session ends: during the start, by rejecting `started`; later, through `onEnd`. A start
 *   that settled on the config's problem is followed, once a fixed config's watch has written its first result, by
 *   `Restarted`, as a restart's is.
 * @param onEnd - Called with a started session's failure, at most once.
 * @param mode - Where change events come from; native file events unless the caller polls.
 * @returns The session's start and stop.
 */
export function watchProject(
  services: Layer.Layer<WatchServices>,
  configPath: string,
  report: (result: SyncResult) => void,
  onEnd: (end: ProjectWatchEnd) => void,
  mode: WatchMode = NATIVE
): ProjectWatcher {
  const stop = Deferred.makeUnsafe<void>();
  const start = Promise.withResolvers<void>();
  const end = Promise.withResolvers<void>();
  // Whether the start has an outcome, recorded in the step that resolves `started`; and whether a close is pending.
  let startedAt: "pending" | "settled" = "pending";
  let closing = false;
  // The follow writes its ready line once, after the first watch's first result. A host has no ready line, but when the
  // start had already settled on the config's problem (an invalid or missing config, fixed since), that first result
  // is a restart's to the host: the catalogs it compiles from now exist, so it is reported as `Restarted`.
  const output: WatchOutput<never> = {
    report: (result) =>
      Effect.sync(() => {
        report(result);
      }),
    ready: Effect.suspend(() =>
      startedAt === "settled" ? writeResult(output, { _tag: "Restarted" }) : Effect.void
    ),
  };
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const following = yield* followConfig(configPath, undefined, mode, stop, output);
      yield* Effect.sync(() => {
        startedAt = "settled";
        start.resolve();
      });
      yield* following.done;
    }).pipe(Effect.scoped, Effect.provide(services))
  );
  // The session's end, once its scope and its services are released.
  fiber.addObserver((exit) => {
    const cause = Exit.isFailure(exit) ? exit.cause : undefined;

    if (startedAt === "pending") {
      start.reject(
        cause === undefined || Cause.hasInterruptsOnly(cause)
          ? new Error("the watch ended before its first result was reported")
          : Cause.squash(cause)
      );
    } else if (cause !== undefined && !Cause.hasInterruptsOnly(cause)) {
      try {
        onEnd({ cause: Cause.squash(cause), closing });
      } catch {
        // `onEnd` is the one reader of the end; a close settles all the same.
      }
    }

    end.resolve();
  });

  return {
    started: start.promise,
    close: () => {
      closing = true;
      Deferred.doneUnsafe(stop, Effect.void);

      return end.promise;
    },
  };
}
