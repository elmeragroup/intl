import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { existsSync } from "node:fs";

import { readConfigSnapshot } from "../src/project-config-read";
import type { ProjectServices } from "../src/project-services";
import type { SyncResult, WatchServices } from "../src/watch";
import { watchCatalogs } from "../src/watch";
import { followConfig } from "../src/watch-follow";
import type { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { syncFileSystem } from "./sync-file-system";
import {
  afterRead,
  catalog,
  claimSensitive,
  CONFIG_READ,
  CONFIG_TEXT,
  ending,
  gates,
  holding,
  NATIVE,
  nextRead,
  outcome,
  refusedOnce,
  SV_TEXT,
  twoTrees,
  within,
} from "./watch-follow-project";
import {
  deliveredEvents,
  it,
  launchFollow,
  launchWatch,
  projectConfig,
  startFollow,
  syncCatalogServices,
  woken,
} from "./watch-project";

// Unit under test: `followConfig`'s start, on the test clock. Oracle: the follow's start contract, by hand: the start
// settles as ready once an iteration has written its first sync's result (or its config's problem) with no newer
// config waiting; a stop the host asked for before then is "stopped", never a failure; otherwise it fails with a
// fatal cause (a write that failed for good, a reader's defect) or with the failure the follow ended with.
describe("followConfig's start", () => {
  it.effect(
    "settles as ready once the watch on a config edited during the first sync has synced",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        const sync = holding((config) => (config.locales.includes("sv") ? gate.second : gate.first));
        const { reports, watching: start } = yield* launchFollow(project, { layer: sync.layer });
        yield* gate.release;
        project.write("elmera-intl.json", SV_TEXT);
        yield* nextRead;
        yield* woken(Deferred.succeed(gate.first, undefined));
        yield* nextRead;
        const whileSecondHeld = [outcome(start), sync.held()];
        yield* woken(Deferred.succeed(gate.second, undefined));
        yield* nextRead;

        expect([whileSecondHeld, outcome(start), reports, catalog(project, "sv")]).toEqual([
          [undefined, 2],
          "Ready",
          ["ConfigChanged", "Written", "Written", "Restarted"],
          expect.stringContaining(`msgid "Hello"`),
        ]);
      })
  );

  it.effect("settles as ready on a config edited while a failed first start cleans up", ({ project }) =>
    Effect.gen(function* () {
      const cleanup = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const events = twoTrees(project, {
        opening: refusedOnce(project, "src"),
        releasing: () => {
          cleanup.resolve();

          return held.promise;
        },
      });
      const { reports, watching: start } = yield* launchFollow(project, {
        mode: NATIVE,
        events: events.layer,
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
      yield* within(
        project,
        Effect.promise(() => cleanup.promise),
        "the cleanup"
      );
      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      held.resolve();
      yield* within(project, Fiber.await(start), "the start");

      // The edited config's watch is the first to sync, so it writes the ready line, never `Restarted`.
      expect([outcome(start), reports, catalog(project, "sv")]).toEqual([
        "Ready",
        ["ConfigChanged", "Written"],
        expect.stringContaining(`msgid "Hello"`),
      ]);
    })
  );

  it.effect("fails with a failed first start's error when the host stops during its cleanup", ({ project }) =>
    Effect.gen(function* () {
      const cleanup = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const events = twoTrees(project, {
        opening: refusedOnce(project, "src"),
        releasing: () => {
          cleanup.resolve();

          return held.promise;
        },
      });
      const { stop, watching: start } = yield* launchFollow(project, { mode: NATIVE, events: events.layer });
      yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
      yield* within(
        project,
        Effect.promise(() => cleanup.promise),
        "the cleanup"
      );
      // A newer config waits, and the host stops: the start that failed on its own still fails.
      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      yield* Deferred.succeed(stop, undefined);
      held.resolve();
      yield* within(project, Fiber.await(start), "the start");

      expect([outcome(start), catalog(project, "sv")]).toEqual([
        "Error: EACCES: permission denied, watch",
        "(missing)",
      ]);
    }).pipe(claimSensitive)
  );

  it.effect(
    "is stopped by a host stop while a tree opens, the watcher's failure to close its end",
    ({ project }) =>
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>();
        const events = twoTrees(project, {
          opening: (dir) => (dir === project.path("src") ? held.promise : undefined),
          closeFails: new Error("watcher close failed"),
        });
        const { stop, watching: start } = yield* launchFollow(project, {
          mode: NATIVE,
          events: events.layer,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
        const opening = [events.open(), events.opening()];
        yield* Deferred.succeed(stop, undefined);
        const settled = yield* within(project, Fiber.await(start), "the start");
        const ended = Exit.isSuccess(settled)
          ? yield* within(project, ending(settled.value.done), "the end")
          : undefined;

        expect([opening, outcome(start), ended, events.open()]).toEqual([
          [[project.path("messages")], 1],
          "Stopped",
          "Error: watcher close failed",
          [],
        ]);
      })
  );

  it.effect.each([
    { fails: "the first result's write and its SyncFailed's", reports: ["Written", "Failed"] },
    { fails: "a reread of the config, by a defect", reports: ["Written"] },
  ])("fails when $fails fail during the start", ({ reports: expected }, { project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      const sync = holding((config) => (config.locales.length === 1 ? gate.first : undefined));
      const reports: Array<SyncResult["_tag"]> = [];
      let breaks = false;
      const reading = expected.length === 1;
      const { watching: start } = yield* launchFollow(project, {
        layer: sync.layer,
        fileSystem: syncFileSystem({
          readFile: (read) => (path) =>
            breaks && path === project.path("elmera-intl.json")
              ? Effect.die(new Error("read defect"))
              : read(path),
        }),
        report: (result) =>
          Effect.sync(() => {
            reports.push(result._tag);

            if (!reading) {
              throw new Error(result._tag === "Failed" ? "logger.error gone" : "logger.info gone");
            }
          }),
      });
      yield* gate.release;
      breaks = reading;
      yield* nextRead;
      yield* woken(Deferred.succeed(gate.first, undefined));
      yield* within(project, Fiber.await(start), "the start");

      expect([outcome(start), reports]).toEqual([
        reading ? "Error: read defect" : "Error: logger.error gone",
        expected,
      ]);
    }).pipe(claimSensitive)
  );

  // The follow's own end reaches a watch still starting: a reread's defect while a tree opens (held, never released)
  // halts that watch, so the start fails with the defect rather than waiting on the tree.
  it.effect("fails with a reread's defect while a tree is still opening", ({ project }) =>
    Effect.gen(function* () {
      const held = Promise.withResolvers<void>();
      const events = twoTrees(project, {
        opening: (dir) => (dir === project.path("src") ? held.promise : undefined),
      });
      let breaks = false;
      const { watching: start } = yield* launchFollow(project, {
        mode: NATIVE,
        events: events.layer,
        fileSystem: syncFileSystem({
          readFile: (read) => (path) =>
            breaks && path === project.path("elmera-intl.json")
              ? Effect.die(new Error("read defect"))
              : read(path),
        }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
      breaks = true;
      yield* afterRead(CONFIG_READ);
      yield* within(project, Fiber.await(start), "the start");

      expect([outcome(start), events.open()]).toEqual(["Error: read defect", []]);
    })
  );

  it.effect.each([
    {
      during: "the follow's own first read",
      first: "own" as const,
      act: (_project: Project, _gate: Deferred.Deferred<void>) => Effect.void,
    },
    {
      during: "the retire of a generation a newer config superseded",
      first: "handed" as const,
      act: Effect.fnUntraced(function* (project: Project, gate: Deferred.Deferred<void>) {
        project.write("elmera-intl.json", SV_TEXT);
        yield* afterRead(CONFIG_READ);
        yield* Deferred.succeed(gate, undefined);
      }),
    },
  ])("is stopped by a host stop during $during, ending clean", ({ first, act }, { project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      const cleanup = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      // Reads of the config wait for the second gate while the follow reads it itself; the first sync waits for the first.
      const reading = first === "own";
      const events = deliveredEvents({
        releasing: () => {
          cleanup.resolve();

          return held.promise;
        },
      });
      const sync = holding((config) => (config.locales.length === 1 ? gate.first : undefined));
      const { stop, watching: start } = yield* launchFollow(project, {
        first,
        mode: NATIVE,
        events: events.layer,
        layer: sync.layer,
        fileSystem: syncFileSystem({
          readFile: (read) => (path) =>
            reading && path === project.path("elmera-intl.json")
              ? Deferred.await(gate.second).pipe(Effect.andThen(read(path)))
              : read(path),
        }),
      });
      yield* gate.release;
      yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
      yield* act(project, gate.first);

      if (!reading) {
        yield* within(
          project,
          Effect.promise(() => cleanup.promise),
          "the cleanup"
        );
      }

      yield* Deferred.succeed(stop, undefined);
      held.resolve();
      const settled = yield* within(project, Fiber.await(start), "the start");
      const ended = Exit.isSuccess(settled)
        ? yield* within(project, ending(settled.value.done), "the end")
        : undefined;

      expect([outcome(start), ended, events.open(), catalog(project, "sv")]).toEqual([
        "Stopped",
        "clean",
        [],
        "(missing)",
      ]);
    }).pipe(claimSensitive)
  );

  it.effect("is stopped by a host stop on an invalid first config, a newer one waiting", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      project.write("elmera-intl.json", "{");
      const reports: Array<SyncResult["_tag"]> = [];
      const { stop, watching: start } = yield* launchFollow(project, {
        report: (result) =>
          (result._tag === "Failed" ? Deferred.await(gate.first) : Effect.void).pipe(
            Effect.andThen(Effect.sync(() => reports.push(result._tag)))
          ),
      });
      yield* gate.release;
      project.write("elmera-intl.json", SV_TEXT);
      yield* nextRead;
      yield* Deferred.succeed(stop, undefined);
      yield* woken(Deferred.succeed(gate.first, undefined));
      const settled = yield* within(project, Fiber.await(start), "the start");
      const ended = Exit.isSuccess(settled)
        ? yield* within(project, ending(settled.value.done), "the end")
        : undefined;

      expect([outcome(start), ended, reports, catalog(project, "sv")]).toEqual([
        "Stopped",
        "clean",
        ["Failed", "ConfigChanged"],
        "(missing)",
      ]);
    })
  );

  // A host's `report` that throws as it is called, before it returns an effect, fails that write as one that fails
  // inside its effect does: written again as `SyncFailed`, and when that throws too, the follow ends with the throw and
  // the start fails with it, no stop needed. The host's stop after it changes nothing.
  it.effect("fails with a report that throws as it is called, on an invalid first config", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", "{");
      const calls: Array<SyncResult["_tag"]> = [];
      const { stop, watching: start } = yield* launchFollow(project, {
        report: (result) => {
          calls.push(result._tag);

          throw new Error("report threw");
        },
      });
      yield* nextRead;
      yield* Deferred.succeed(stop, undefined);
      yield* nextRead;

      expect([outcome(start), calls]).toEqual(["Error: report threw", ["Failed", "Failed"]]);
    })
  );

  it.effect(
    "is stopped by a host stop that halts the first start clean, a newer config waiting",
    ({ project }) =>
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>();
        const events = twoTrees(project, {
          opening: (dir) => (dir === project.path("src") ? held.promise : undefined),
        });
        const { stop, watching: start } = yield* launchFollow(project, {
          mode: NATIVE,
          events: events.layer,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
        project.write("elmera-intl.json", SV_TEXT);
        yield* afterRead(CONFIG_READ);
        yield* Deferred.succeed(stop, undefined);
        const settled = yield* within(project, Fiber.await(start), "the start");
        const ended = Exit.isSuccess(settled)
          ? yield* within(project, ending(settled.value.done), "the end")
          : undefined;

        expect([outcome(start), ended, events.open(), catalog(project, "sv")]).toEqual([
          "Stopped",
          "clean",
          [],
          "(missing)",
        ]);
      })
  );

  // Once the start has settled, a host stop during a restart's start (a tree still opening) whose watcher then fails to
  // close ends the follow with that failure: the stop halted it, so it never reads as a watch that failed to start. A
  // close that fails at once, on the default scheduler, runs the restart's whole stop inside the step that claims its
  // halt, so the claim is on record before that step completes the halt, or it reads as lost.
  it.effect.each([
    { closes: "on a later turn", closeFailsWhen: "later" as const, yieldsEachOp: true },
    { closes: "at once", closeFailsWhen: "at once" as const, yieldsEachOp: false },
  ])(
    "ends with a restart's watcher failing to close $closes after a host stop during its start",
    ({ closeFailsWhen, yieldsEachOp }, { project }) =>
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>();
        project.write("elmera-intl.json", "{");
        const events = twoTrees(project, {
          opening: (dir) => (dir === project.path("src") ? held.promise : undefined),
          closeFails: new Error("watcher close failed"),
          closeFailsWhen,
        });
        const { reports, stop, watching } = yield* startFollow(project, {
          mode: NATIVE,
          events: events.layer,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()));
        project.write("elmera-intl.json", CONFIG_TEXT);
        yield* afterRead(CONFIG_READ);
        const opening = [events.open(), events.opening()];
        yield* Deferred.succeed(stop, undefined);
        const ended = yield* within(project, ending(watching.done), "the end");

        expect([watching._tag, opening, ended, reports]).toEqual([
          "Ready",
          [[project.path("messages")], 1],
          "Error: watcher close failed",
          ["Failed", "ConfigChanged"],
        ]);
      }).pipe((test) => (yieldsEachOp ? claimSensitive(test) : test))
  );

  it.effect(
    "fails when a superseded generation's watcher fails to close, the host not stopping",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        const sync = holding((config) => (config.locales.length === 1 ? gate.first : undefined));
        const events = deliveredEvents({ closeFails: new Error("watcher close failed") });
        const { watching: start } = yield* launchFollow(project, {
          mode: NATIVE,
          events: events.layer,
          layer: sync.layer,
        });
        yield* gate.release;
        project.write("elmera-intl.json", SV_TEXT);
        yield* afterRead(CONFIG_READ);
        yield* woken(Deferred.succeed(gate.first, undefined));
        yield* within(project, Fiber.await(start), "the start");

        expect(outcome(start)).toBe("Error: watcher close failed");
      })
  );

  // The caller's scope closing is no host stop and no failure: the start is stopped, and the follow's end goes to one
  // recipient only, as `watchCatalogs` hands it (`watch.ts`): the start waiting for it first, the scope's close only
  // once the start is interrupted, so no failure is reported twice and none is lost. Each row on the default scheduler
  // and with every fiber yielding after each operation, so who is handed the end never rests on which fiber runs first.
  it.effect.each(
    [
      {
        ends: "cleanly",
        closeFails: undefined,
        interrupted: false,
        expected: { start: "Stopped", done: "clean", closed: "clean" },
      },
      {
        ends: "with a watcher failing to close",
        closeFails: new Error("watcher close failed"),
        interrupted: false,
        expected: { start: "Error: watcher close failed", done: undefined, closed: "clean" },
      },
      {
        ends: "with a watcher failing to close, its start interrupted",
        closeFails: new Error("watcher close failed"),
        interrupted: true,
        expected: { start: "interrupted", done: undefined, closed: "Error: watcher close failed" },
      },
    ].flatMap((row) => [
      { ...row, scheduler: "on the default scheduler", yieldsEachOp: false },
      { ...row, scheduler: "yielding after each operation", yieldsEachOp: true },
    ])
  )(
    "settles, with every watcher closed, when the caller's scope closes during a held first sync and $ends, $scheduler",
    ({ closeFails, interrupted, expected, yieldsEachOp }, { project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        const sync = holding(() => gate.first);
        const events = deliveredEvents(closeFails === undefined ? {} : { closeFails });
        const { scope, watching: start } = yield* launchFollow(project, {
          mode: NATIVE,
          events: events.layer,
          layer: sync.layer,
        });
        yield* gate.release;

        if (interrupted) {
          yield* Fiber.interrupt(start);
        }

        const closing = yield* Effect.forkChild(ending(Scope.close(scope, Exit.void)));
        yield* woken(Deferred.succeed(gate.first, undefined));
        const closed = yield* within(project, Fiber.join(closing), "the close");
        const settled = yield* within(project, Fiber.await(start), "the start");
        const done = Exit.isSuccess(settled)
          ? yield* within(project, ending(settled.value.done), "the end")
          : undefined;

        expect({
          start:
            Exit.isFailure(settled) && Cause.hasInterruptsOnly(settled.cause)
              ? "interrupted"
              : outcome(start),
          done,
          closed,
          open: events.open(),
        }).toEqual({ ...expected, open: [] });
      }).pipe((test) => (yieldsEachOp ? claimSensitive(test) : test))
  );
});

// Unit under test: `handOff` (watch.ts), the one hand-off of a watch's end, through `watchCatalogs` and `followConfig`.
// Oracle: the contract by hand: a watch's end has one recipient. The host stops, a watcher then fails to close, and
// the caller's scope closes before anyone takes `done`: the close reports the failure, and a `done` taken after the
// close ends clean. (`watchCatalogs`' start, when the stop lands during its first sync, fails with the failure and is
// its one recipient: `watch-clock.test.ts` holds that.) Each row on
// the default scheduler and with every fiber yielding after each operation, so who is handed the end never rests on
// which fiber runs first. The order where `done` is taken before the close is the held-sync matrix's above.
describe("a watch's end, the caller's scope closing before `done` is taken", () => {
  it.effect.each(
    [
      {
        unit: "watchCatalogs",
        when: "after its start",
        start: "Started",
        closed: "Error: watcher close failed",
        done: "clean",
      },
      {
        unit: "followConfig",
        when: "during its first sync",
        start: "Stopped",
        closed: "Error: watcher close failed",
        done: "clean",
      },
      {
        unit: "followConfig",
        when: "after its start",
        start: "Ready",
        closed: "Error: watcher close failed",
        done: "clean",
      },
    ].flatMap((row) => [
      { ...row, scheduler: "on the default scheduler", yieldsEachOp: false },
      { ...row, scheduler: "yielding after each operation", yieldsEachOp: true },
    ])
  )(
    "reaches one recipient when $unit's host stops $when, $scheduler",
    ({ unit, when, yieldsEachOp, ...expected }, { project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        const sync = holding(() => gate.first);
        const events = deliveredEvents({ closeFails: new Error("watcher close failed") });
        const options = { mode: NATIVE, events: events.layer, layer: sync.layer };
        // How the start settled (`watchCatalogs` has one outcome), and its `done`.
        const { stop, scope, settles } =
          unit === "watchCatalogs"
            ? yield* launchWatch(project, options).pipe(
                Effect.map(({ watching, ...run }) => ({
                  ...run,
                  settles: Fiber.await(watching).pipe(
                    Effect.map(Exit.map(({ done }) => ({ settled: "Started", done })))
                  ),
                }))
              )
            : yield* launchFollow(project, options).pipe(
                Effect.map(({ watching, ...run }) => ({
                  ...run,
                  settles: Fiber.await(watching).pipe(
                    Effect.map(Exit.map(({ _tag, done }) => ({ settled: _tag, done })))
                  ),
                }))
              );
        yield* gate.release;
        const duringFirstSync = when === "during its first sync";

        if (!duringFirstSync) {
          yield* woken(Deferred.succeed(gate.first, undefined));
        }

        yield* Deferred.succeed(stop, undefined);

        if (duringFirstSync) {
          yield* woken(Deferred.succeed(gate.first, undefined));
        }

        const settled = yield* within(project, settles, "the start");
        const closed = yield* within(project, ending(Scope.close(scope, Exit.void)), "the close");
        const done = Exit.isSuccess(settled)
          ? yield* within(project, ending(settled.value.done), "the end")
          : undefined;

        expect({
          start: Exit.isSuccess(settled) ? settled.value.settled : String(Cause.squash(settled.cause)),
          closed,
          done,
          open: events.open(),
        }).toEqual({ start: expected.start, closed: expected.closed, done: expected.done, open: [] });
      }).pipe((test) => (yieldsEachOp ? claimSensitive(test) : test))
  );
});

// Unit under test: `watchCatalogs`, and `followConfig` on it, in a caller scope that closes before, or while, it
// starts, on native events a test records. Oracle: the contract by hand: a watch's scope may close at any point, and
// its start and the close both settle, with every watcher it opened closed; a scope closed before the start opens
// none and syncs nothing.
// Each sweep starts a watch for each number of yields on the synchronous file system (`syncCatalogServices`) and the
// test clock, so nothing in a start waits on the event loop (a read in Node's thread pool, a timer), and it runs on a
// synchronous scheduler (`sweeping`). A sweep's cost grows with the square of the start's yields, and on Effect's
// default scheduler each yield is a macrotask (a `setImmediate`): the event loop's turns, not the steps, were most of
// it, so that a loaded machine took the sweeps up to the deadline. On the synchronous scheduler a yield is a microtask,
// and a sweep has the offsets it has on the default one, at each of which the interruption or the close lands where it
// does there (measured: the start's operations, file system calls and watcher opens; for the interruptions, also the
// step of the start's fiber each lands after).
// The suite's timeout is a hang guard only, never a budget a sweep's run time must fit. A sweep is one chain of
// microtasks, during which no timer fires, so the project's deadline (`project.within`, 18 s, inside the 20 s timeout)
// cannot end it: `sweeping` ends a sweep that would not end by counting steps, never time, and reports the offset it
// stalled at, parked (the sweep's chain waits anywhere, on nothing that can come, reported at the offset it was on) or
// spinning (an offset dispatching more than `DISPATCH_BOUND` tasks, a fiber that yields in a loop it never leaves).
// Measured on a 12-core Mac, three runs each: the slowest sweep (followConfig's) took at most 373 ms idle (load 4-8) and
// 2,626 ms at load 40-64, 48× and 6.9× inside the deadline (once 5,254 ms at load 91-101).
describe.for(["watchCatalogs", "followConfig"])(
  "a caller scope that closes before or during %s's start",
  { timeout: 20_000 },
  (start) => {
    function watchIn(project: Project, scope: Scope.Scope, events: Layer.Layer<FileEvents>) {
      const output = { report: () => Effect.void, ready: Effect.void };
      const path = project.path("elmera-intl.json");

      // How the start settled (`followConfig`'s outcome; `watchCatalogs` has one), and its `done`.
      const starting: Effect.Effect<
        { readonly settled: string; readonly done: Effect.Effect<void> },
        never,
        WatchServices | ProjectServices | Scope.Scope
      > =
        start === "watchCatalogs"
          ? watchCatalogs(
              projectConfig(project),
              { _tag: "native" },
              Deferred.makeUnsafe<void>(),
              output
            ).pipe(Effect.map(({ done }) => ({ settled: "Started", done })))
          : readConfigSnapshot(path).pipe(
              Effect.flatMap((first) =>
                followConfig(path, first, { _tag: "native" }, Deferred.makeUnsafe<void>(), output)
              ),
              Effect.map(({ _tag, done }) => ({ settled: _tag, done }))
            );

      return starting.pipe(Scope.provide(scope), Effect.provide([syncCatalogServices(), events]));
    }

    /**
     * Where a sweep stopped short: the offset whose run neither settled nor went on. `parked`, it waits on nothing that
     * can come; `spinning`, it went on dispatching past the bound (`DISPATCH_BOUND`) without settling.
     */
    type Stall = { readonly offset: number; readonly as: "parked" | "spinning" };

    /**
     * A sweep's outcome: whether it reached an offset the start had ended before, the offsets that did not settle as
     * the contract says, and the offset it stalled at, if it did.
     */
    type Swept = {
      readonly swept: boolean;
      readonly unsettled: ReadonlyArray<number>;
      readonly stalled: Stall | undefined;
    };

    /**
     * How each offset of a sweep settles the start, and whether what it settled to is what the contract says. `open`
     * is the number of watchers still open once it has.
     */
    type Settling =
      | {
          /** The start is interrupted, then the scope closes. */
          readonly by: "interrupt";
          readonly settles: (settled: { readonly closed: Exit.Exit<void>; readonly open: number }) => boolean;
        }
      | {
          /** The scope closes, then the start and its `done` are awaited. */
          readonly by: "close";
          readonly settles: (settled: {
            readonly closed: Exit.Exit<void>;
            readonly exit: Exit.Exit<{ readonly settled: string }>;
            readonly ended: Exit.Exit<unknown>;
            readonly open: number;
          }) => boolean;
        };

    // The tasks one offset of a sweep may dispatch before it is a spin: 100× the most any offset of any row dispatches
    // unmutated (1,619, followConfig's close at its last offset, where the whole start runs; measured on the synchronous
    // scheduler, whose count is the same on every run).
    const DISPATCH_BOUND = 161_900;

    /**
     * Runs a sweep with the scheduler yielding every `budget` operations, on a synchronous scheduler and the test clock:
     * for each number of yields in turn, it starts a watch, yields that many times and settles the start as `settling`
     * says, until the start has ended before it is settled. The sweep's own steps while it yields never count toward the
     * budget, so each of its yields is one turn of every other fiber: a fiber that yields waits behind the sweep for its
     * next turn, and from one offset to the next the interruption or the close moves on by one of the start's turns
     * (after a wait, a fiber woken in another's turn may run on within that turn). The sweep's steps between the fork
     * and its yields, and before it settles, still yield on the budget, so the first few of the start's steps (setting
     * up its layers, at offset 0) are passed in one; the 1,000 offsets bound how many turns it reaches.
     *
     * On that scheduler every step of every fiber is a microtask, so the event loop's next turn comes only once all of
     * them wait, and no timer fires while a sweep runs. Two checks end a sweep that would otherwise not end, each with
     * the offset it stalled at. A sweep that has not ended by the event loop's next turn (one `setImmediate`, armed as
     * it starts) waits, wherever it is, on nothing that can come (no read, no timer, no promise of its own is
     * outstanding in a sweep): it is `parked`, at the offset it was on. An offset that
     * dispatches more than `DISPATCH_BOUND` tasks is `spinning` (a fiber that yields in a loop it never leaves, which
     * would keep the microtask queue busy and the event loop, every timer, and the worker with it, held for good): the
     * scheduler drops every task from there on. Both count steps, never time. The scheduler is the run's own (where the
     * test clock wraps it as it wraps the default one), and the bookkeeping is plain calls, not Effect steps, so the
     * interruption and the close land where they do on the default scheduler.
     *
     * @param project - The test's project, whose deadline guards the sweep.
     * @param budget - The operations the scheduler allows between yields.
     * @param settling - How each offset settles the start, and the contract it checks.
     * @returns The sweep's outcome.
     */
    function sweeping(project: Project, budget: number, settling: Settling): Promise<Swept> {
      const events = deliveredEvents();
      const unsettled: Array<number> = [];
      // The one promise of the sweep: settled by the run's exit, or by a stall, whichever comes first.
      const result = Promise.withResolvers<Swept>();
      let current = 0;
      let dispatched = 0;
      let stalled: Stall | undefined;
      const stop = (as: Stall["as"]) => {
        clearImmediate(parking);
        stalled ??= { offset: current, as };
        result.resolve({ swept: false, unsettled: [...unsettled], stalled });
      };
      const sync = new Scheduler.MixedScheduler("sync");
      const scheduler: Scheduler.Scheduler = {
        executionMode: sync.executionMode,
        shouldYield: (fiber) => sync.shouldYield(fiber),
        makeDispatcher: () => {
          const dispatcher = sync.makeDispatcher();

          return {
            scheduleTask: (task, priority) => {
              dispatched += 1;

              if (stalled === undefined && dispatched > DISPATCH_BOUND) {
                stop("spinning");
              }

              if (stalled === undefined) {
                dispatcher.scheduleTask(task, priority);
              }
            },
            flush: () => {
              dispatcher.flush();
            },
          };
        },
      };
      const swept = Effect.gen(function* () {
        for (let yields = 0; yields < 1_000; yields += 1) {
          current = yields;
          dispatched = 0;
          const scope = yield* Scope.make();
          const starting = yield* Effect.forkDetach(watchIn(project, scope, events.layer));

          // Never yielding but where it says, so each yield is one turn of every other fiber.
          yield* Effect.gen(function* () {
            for (let turn = 0; turn < yields; turn += 1) {
              yield* Effect.yieldNow;
            }
          }).pipe(Effect.provideService(References.PreventSchedulerYield, true));

          const startedFirst = starting.pollUnsafe() !== undefined;
          let settles: boolean;

          if (settling.by === "interrupt") {
            yield* Fiber.interrupt(starting);
            const closed = yield* Effect.exit(Scope.close(scope, Exit.void));
            settles = settling.settles({ closed, open: events.open().length });
          } else {
            const closed = yield* Effect.exit(Scope.close(scope, Exit.void));
            const exit = yield* Fiber.await(starting);
            const ended = Exit.isSuccess(exit) ? yield* Effect.exit(exit.value.done) : exit;
            settles = settling.settles({ closed, exit, ended, open: events.open().length });
          }

          if (!settles) {
            unsettled.push(yields);
          }

          if (startedFirst) {
            return yields > 0;
          }
        }

        return false;
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, budget), Effect.provide(TestClock.layer()));

      // The sweep is one chain of microtasks, so this runs only once that chain waits, at whichever offset it is on, or
      // never, cleared when the sweep settles.
      const parking = setImmediate(() => {
        stop("parked");
      });
      Effect.runCallback(swept, {
        scheduler,
        onExit: (exit) => {
          clearImmediate(parking);

          if (Exit.isSuccess(exit)) {
            result.resolve({ swept: exit.value, unsettled, stalled });
          } else {
            result.reject(Cause.squash(exit.cause));
          }
        },
      });

      return project.within(result.promise, "the sweep");
    }

    // With the scheduler yielding after each number of operations a budget allows, the start is interrupted after each
    // number of its yields in turn, until it has ended before that, and then the scope closes: an interrupted start
    // takes nothing, so wherever the interruption lands the close settles, clean, with every watcher closed. An
    // interruption lands only where the start's fiber yields or waits. At budget 1 it yields after every operation, and
    // the sweep moves on by one of its turns per offset (`sweeping`), past its first setup steps and within the offset
    // cap, however many operations come first: that reaches the yield between a claim on the follow's end and its
    // release (`handOff` in watch.ts), which, left interruptible, leaves the close waiting for ever. Budgets 4 and 6 run
    // each fiber several operations a turn, an interleaving of the start's fibers budget 1 never makes.
    it.for([1, 4, 6])(
      "settles the close wherever an interruption lands in the start, yielding every %i operations",
      async (budget, { project }) => {
        const swept = sweeping(project, budget, {
          by: "interrupt",
          settles: ({ closed, open }) => Exit.isSuccess(closed) && open === 0,
        });

        expect(await swept).toEqual({ swept: true, unsettled: [], stalled: undefined });
      }
    );

    it("settles its start in a scope closed already, opening no tree", async ({ project }) => {
      const events = deliveredEvents();
      const scope = Scope.makeUnsafe();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const exit = await project.within(
        Effect.runPromiseExit(
          watchIn(project, scope, events.layer).pipe(
            Effect.flatMap(({ settled, done }) => Effect.exit(done).pipe(Effect.map((end) => [settled, end])))
          )
        ),
        "the start"
      );

      // A scope closed before the start is no failure: a follow's start is stopped, and its end clean.
      expect([
        Exit.isSuccess(exit) ? exit.value : exit,
        events.calls(),
        events.open(),
        existsSync(project.path("messages/nb.po")),
      ]).toEqual([[start === "watchCatalogs" ? "Started" : "Stopped", Exit.void], 0, [], false]);
    });

    // With the scheduler yielding after every operation, the close lands after each number of the start's yields in
    // turn, until the start has ended before it.
    it("settles its start and the close wherever the close lands in the start", async ({ project }) => {
      const swept = sweeping(project, 1, {
        by: "close",
        // Wherever the close lands, the start is ready (it settled before the close) or stopped, never failed, and the
        // close and the watch's end are clean.
        settles: ({ closed, exit, ended, open }) =>
          Exit.isSuccess(exit) &&
          ["Started", "Ready", "Stopped"].includes(exit.value.settled) &&
          Exit.isSuccess(closed) &&
          Exit.isSuccess(ended) &&
          open === 0,
      });

      expect(await swept).toEqual({ swept: true, unsettled: [], stalled: undefined });
    });
  }
);
