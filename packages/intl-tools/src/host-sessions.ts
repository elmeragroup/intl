// A host's runtimes, one per host session (a build environment): each session's programs run on its own runtime,
// which only that session's end disposes, so one host instance can build several environments side by side.
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

/**
 * Runtimes keyed by host session.
 *
 * @template K - What identifies a session (a build environment).
 * @template R - The services every runtime provides.
 */
export type HostSessions<K extends object, R> = {
  /**
   * Runs `effect` on the session's runtime, made on first use (again after a release); releasing the session waits
   * for the run to end.
   *
   * @template A - The effect's result.
   * @template E - The effect's failures.
   * @param key - The session.
   * @param effect - The program.
   * @returns What `effect` succeeds with; rejects with what it failed or died with.
   */
  readonly run: <A, E>(key: K, effect: Effect.Effect<A, E, R>) => Promise<A>;
  /**
   * Ends the session: its runtime is disposed once the runs on it, and any earlier disposal on the key, have settled,
   * and its next use makes a new one. Rejects only with this session's own disposal failure: an earlier session's
   * belongs to the release that ended it. Safe to call again, or for a session with no runtime: it then shares the
   * outcome of the disposal still under way on the key, if any.
   *
   * @param key - The session.
   * @returns Once the session's runtime is disposed.
   */
  readonly release: (key: K) => Promise<void>;
};

/**
 * Runtimes for a host's sessions, each built from `layer`.
 *
 * @template K - What identifies a session.
 * @template R - The services `layer` provides.
 * @param layer - The services every session's runtime provides.
 * @returns The sessions.
 */
export function hostSessions<K extends object, R>(layer: Layer.Layer<R>): HostSessions<K, R> {
  type Session = {
    readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
    // The runs on it: its release waits for them before disposing the runtime, so a release landing mid-run (a check
    // yields while it reports) never cuts one short.
    readonly running: Set<Promise<unknown>>;
  };
  const sessions = new WeakMap<K, Session>();
  // The disposal under way on each key, until it settles: a settled one, failed or not, never reaches a later release.
  const disposals = new WeakMap<K, Promise<void>>();
  const session = (key: K): Session => {
    const live = sessions.get(key);

    if (live !== undefined) {
      return live;
    }

    const made: Session = { runtime: ManagedRuntime.make(layer), running: new Set() };
    sessions.set(key, made);

    return made;
  };

  return {
    run: async (key, effect) => {
      const { runtime, running } = session(key);
      const run = runtime.runPromise(effect);
      running.add(run);

      try {
        return await run;
      } finally {
        running.delete(run);
      }
    },
    release: (key) => {
      const ended = sessions.get(key);

      if (ended === undefined) {
        return disposals.get(key) ?? Promise.resolve();
      }

      sessions.delete(key);
      const disposal: Promise<void> = Promise.allSettled([disposals.get(key), ...ended.running])
        .then(() => ended.runtime.dispose())
        .finally(() => {
          if (disposals.get(key) === disposal) {
            disposals.delete(key);
          }
        });
      disposals.set(key, disposal);

      return disposal;
    },
  };
}
