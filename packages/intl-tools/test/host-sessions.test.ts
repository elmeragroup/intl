import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import { hostSessions } from "../src/host-sessions";

// Unit under test: a host's sessions, as the Vite plugin keys its builds: a watch build that rebuilds, and a one-off
// build of the same plugin beside it, run and released. Oracle: the contract, by hand: each session builds its
// services once, on first use, and only its own release ends it, so the watch build's rebuild after the one-off build's
// end builds nothing.
it("builds a session's services once, whatever another session's release", async () => {
  let built = 0;
  const sessions = hostSessions<object, never>(
    Layer.effectDiscard(
      Effect.sync(() => {
        built += 1;
      })
    )
  );
  const watchBuild = {};
  const oneOff = {};
  const counts: Array<number> = [];

  await sessions.run(watchBuild, Effect.void);
  counts.push(built);
  await sessions.run(oneOff, Effect.void);
  counts.push(built);
  await sessions.release(oneOff);
  await sessions.run(watchBuild, Effect.void);
  counts.push(built);
  await sessions.release(watchBuild);

  expect(counts).toEqual([1, 2, 2]);
});

// Unit under test: a session's release after an earlier session on the same key failed to dispose (a build environment
// rebuilt after its runtime's finalizer failed). Oracle: the release contract, by hand: the failure is the release's
// that ended that session; a later release waits for its own session's runs and disposal, and settles as they did.
it("releases a key's next session on its own, after an earlier session's disposal failed", async () => {
  let made = 0;
  const gate = Promise.withResolvers<void>();
  const events: Array<string> = [];
  const sessions = hostSessions<object, never>(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          made += 1;

          return made;
        }),
        (session) =>
          session === 1
            ? Effect.die(new Error("dispose 1 failed"))
            : Effect.promise(() => gate.promise).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    events.push("disposed 2");
                  })
                )
              )
      )
    )
  );
  const key = {};

  await sessions.run(key, Effect.void);
  await expect(sessions.release(key)).rejects.toThrow("dispose 1 failed");
  await expect(sessions.release(key)).resolves.toBeUndefined();
  const run = sessions.run(
    key,
    Effect.promise(() => gate.promise).pipe(
      Effect.andThen(
        Effect.sync(() => {
          events.push("ran 2");
        })
      )
    )
  );
  const released = sessions.release(key);
  gate.resolve();
  await released;
  events.push("released 2");
  await run;

  expect(events).toEqual(["ran 2", "disposed 2", "released 2"]);
});
