import { describe, expect } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { Change } from "../src/watch-trees";
import { startPolling } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { it, woken } from "./watch-project";

// The poll's cadence on the test clock, where a walk takes as long as the test says (#82). Unit under test:
// `startPolling`. Oracle: its contract, by hand: no walk after the first until one interval after the first sync has
// run, however long it ran; a round starting no sooner than one interval after the previous one ended, the trees
// walked one after another within it; a change delivered by a round that starts at most one interval after the
// round in progress at the change ends.
describe("startPolling on the test clock", () => {
  const INTERVAL_MS = 50;

  // Trees to poll, each (`tree` unless the test names others) holding one directory, read by a clock whose monotonic
  // time each walk moves by the time the test gives it, and whose sleeps end by that time: a real walk takes no
  // test-clock time, and the test clock cannot be stepped from inside a walk, which is synchronous. Every walk asks
  // `prune` about its tree's `sub` once, as it lists the tree's root: that is where a walk's start is recorded, its time added and `during` called (a file written
  // to the root then is not seen by that walk, which has listed the root already). Walks are counted across the trees,
  // from 1. `starts` holds each walk's start, `walked` its tree, and `deliveries` each walk's changes with the time
  // they were handed over, in milliseconds on that clock.
  const polledTree = Effect.fnUntraced(function* (
    project: Project,
    walkMs: (walk: number) => number,
    during: (walk: number) => void = () => undefined,
    names: ReadonlyArray<string> = ["tree"]
  ) {
    const testClock = yield* Clock.Clock;
    let taken = 0n;
    const monotonic = () => testClock.monotonicTimeNanosUnsafe() + taken;
    const ms = () => Number(monotonic() / 1_000_000n);
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe(),
      currentTimeMillis: testClock.currentTimeMillis,
      currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe(),
      currentTimeNanos: testClock.currentTimeNanos,
      monotonicTimeNanosUnsafe: monotonic,
      monotonicTimeNanos: Effect.sync(monotonic),
      // Due by this clock, as the event loop's timers are by real time: a sleep that falls due during a walk ends as
      // soon as the walk does. The test clock moves it a millisecond at a time.
      sleep: Effect.fnUntraced(function* (duration: Duration.Duration) {
        const due = monotonic() + Duration.toNanosUnsafe(duration);

        while (monotonic() < due) {
          yield* testClock.sleep(Duration.millis(1));
        }
      }),
    };
    const starts: Array<number> = [];
    const walked: Array<string> = [];
    const deliveries: Array<{ readonly at: number; readonly changes: ReadonlyArray<Change> }> = [];
    const waiting: Array<{ readonly walks: number; readonly reached: Deferred.Deferred<void> }> = [];
    const subs = new Map(
      names.map((name) => {
        project.write(`${name}/sub/a.txt`, "a");

        return [project.path(`${name}/sub`), name] as const;
      })
    );
    const prune = (directory: string): boolean => {
      const tree = subs.get(directory);

      if (tree !== undefined) {
        starts.push(ms());
        walked.push(tree);
        during(starts.length);
        taken += BigInt(walkMs(starts.length)) * 1_000_000n;

        for (const { walks, reached } of waiting) {
          if (walks <= starts.length) {
            Deferred.doneUnsafe(reached, Effect.void);
          }
        }
      }

      return false;
    };
    const poll = (firstSynced: Effect.Effect<void>) =>
      startPolling(
        names.map((name) => project.path(name)),
        INTERVAL_MS,
        prune,
        (item) => {
          if (item.changes.length > 0) {
            deliveries.push({ at: ms(), changes: item.changes });
          }
        },
        (walking) => walking,
        firstSynced
      ).pipe(Effect.provideService(Clock.Clock, clock));

    // Until the `walks`th walk has started: a round's walk after its first follows a turn of the real event loop, which
    // the test clock does not wait for.
    const untilWalks = (walks: number) =>
      Effect.suspend(() => {
        if (starts.length >= walks) {
          return Effect.void;
        }

        const reached = Deferred.makeUnsafe<void>();
        waiting.push({ walks, reached });

        return Deferred.await(reached);
      });

    return { poll, starts, walked, deliveries, untilWalks };
  });

  it.effect(
    "walks no tree after its first walk until one interval after the first sync has run",
    ({ project }) =>
      Effect.gen(function* () {
        const synced = yield* Deferred.make<void>();
        // Every later walk takes 120 ms, longer than the interval (the first three of them, so a cadence that ran them
        // back to back still ends).
        const tree = yield* polledTree(project, (walk) => (walk >= 2 && walk <= 4 ? 120 : 0));
        yield* tree.poll(Deferred.await(synced));
        // The first sync holds across four intervals.
        yield* TestClock.adjust("200 millis");
        expect(tree.starts).toEqual([0]);

        // It completes at 201 ms, long past the 50 ms an interval after the first walk: the next walk starts an interval
        // after the sync, at 251 ms, not at once.
        yield* woken(Deferred.succeed(synced, undefined));
        yield* TestClock.adjust("49 millis");
        expect(tree.starts).toEqual([0]);

        yield* TestClock.adjust("1 millis");
        expect(tree.starts).toEqual([0, 251]);
      })
  );

  it.effect(
    "starts a round one interval after the previous round ends, however many trees it walks",
    ({ project }) =>
      Effect.gen(function* () {
        // Two trees, each walk of the second round taking 30 ms: together 60 ms, longer than the interval. A callback
        // the host queues during `a`'s walk in it runs before `b`'s walk starts: the poll gives the event loop a turn.
        let queuedRan = false;
        let ranBeforeB: boolean | undefined;
        const tree = yield* polledTree(
          project,
          (walk) => (walk === 3 || walk === 4 ? 30 : 0),
          (walk) => {
            if (walk === 3) {
              setImmediate(() => {
                queuedRan = true;
              });
            } else if (walk === 4) {
              ranBeforeB = queuedRan;
            }
          },
          ["a", "b"]
        );
        yield* tree.poll(Effect.void);
        // The second round walks `a` from 50 ms to 80 ms, then `b` from 80 ms to 110 ms.
        yield* TestClock.adjust("50 millis");
        yield* tree.untilWalks(4);
        expect({ starts: tree.starts, walked: tree.walked, ranBeforeB }).toEqual({
          starts: [0, 0, 50, 80],
          walked: ["a", "b", "a", "b"],
          ranBeforeB: true,
        });

        // The third starts at 160 ms, one interval after the second ended, whatever either tree's own last walk.
        yield* TestClock.adjust("49 millis");
        expect(tree.starts).toEqual([0, 0, 50, 80]);

        yield* TestClock.adjust("1 millis");
        yield* tree.untilWalks(6);
        expect({ starts: tree.starts, walked: tree.walked }).toEqual({
          starts: [0, 0, 50, 80, 160, 160],
          walked: ["a", "b", "a", "b", "a", "b"],
        });
      })
  );

  it.effect(
    "delivers a change made as a round starts within one interval plus two rounds of it",
    ({ project }) =>
      Effect.gen(function* () {
        const WALK_MS = 80;
        // The second and third walks take 80 ms; a file is added to the tree's root as the second starts, at 50 ms.
        const tree = yield* polledTree(
          project,
          (walk) => (walk === 2 || walk === 3 ? WALK_MS : 0),
          (walk) => {
            if (walk === 2) {
              project.write("tree/new.txt", "new");
            }
          }
        );
        yield* tree.poll(Effect.void);
        yield* TestClock.adjust("100 millis");
        // The second walk, in progress at the change, ends at 130 ms without it; the third starts one interval later and
        // delivers it as it ends, at 260 ms: the bound, one interval plus two rounds (of one tree, 50 + 2 × WALK_MS)
        // after 50 ms.
        expect({ starts: tree.starts, deliveries: tree.deliveries }).toEqual({
          starts: [0, 50, 180],
          deliveries: [{ at: 260, changes: [{ event: "rename", path: project.path("tree/new.txt") }] }],
        });
      })
  );
});
