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
