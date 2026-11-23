// A host's runtimes, one per host session (a dev server, a build): each session's programs run on its own runtime,
// which only that session's end disposes, so one host instance can serve, restart and build side by side.
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

/**
 * Runtimes keyed by host session.
 *
 * @template K - What identifies a session (a dev server's or a build's resolved config).
 * @template R - The services every runtime provides.
 */
export type HostSessions<K extends object, R> = {
  /**
   * The session's runtime, made on first use (again after a release).
   *
   * @param key - The session.
   * @returns Its runtime.
   */
  readonly runtime: (key: K) => ManagedRuntime.ManagedRuntime<R, never>;
  /**
   * Runs `effect` on the session's runtime; releasing the session waits for the run to end.
   *
   * @template A - The effect's result.
   * @template E - The effect's failures.
   * @param key - The session.
   * @param effect - The program.
   * @returns What `effect` succeeds with; rejects with what it failed or died with.
   */
  readonly run: <A, E>(key: K, effect: Effect.Effect<A, E, R>) => Promise<A>;
  /**
   * Ends the session: its runtime is disposed once the runs on it have ended (any watch still on it is interrupted
   * and closed), and its next use makes a new one. Safe to call again, or for a session with no runtime: it then
   * waits for the disposal already under way.
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
    // The runs on it: a session ends only once they have, so another environment's end never cuts one short (a check
    // yields while it reports).
    readonly running: Set<Promise<unknown>>;
  };
  const sessions = new WeakMap<K, Session>();
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
    runtime: (key) => session(key).runtime,
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
      sessions.delete(key);

      if (ended !== undefined) {
        const disposing = Promise.allSettled(ended.running).then(() => ended.runtime.dispose());
        disposals.set(
          key,
          Promise.all([disposals.get(key), disposing]).then(() => undefined)
        );
      }

      return disposals.get(key) ?? Promise.resolve();
    },
  };
}
