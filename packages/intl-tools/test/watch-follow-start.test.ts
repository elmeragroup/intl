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
        fileSystem: syncFileSystem(
          (read) => (path) =>
            breaks && path === project.path("elmera-intl.json")
              ? Effect.die(new Error("read defect"))
              : read(path)
        ),
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
        fileSystem: syncFileSystem(
          (read) => (path) =>
            breaks && path === project.path("elmera-intl.json")
              ? Effect.die(new Error("read defect"))
              : read(path)
        ),
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
        fileSystem: syncFileSystem(
          (read) => (path) =>
            reading && path === project.path("elmera-intl.json")
              ? Deferred.await(gate.second).pipe(Effect.andThen(read(path)))
              : read(path)
        ),
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
// close ends clean; neither start takes it, `watchCatalogs`' saying only who began the stop. Each row on the default
// scheduler and with every fiber yielding after each operation, so who is handed the end never rests on which fiber
// runs first. The order where `done` is taken before the close is the held-sync matrix's above.
describe("a watch's end, the caller's scope closing before `done` is taken", () => {
  it.effect.each(
    [
      {
        unit: "watchCatalogs",
        when: "during its first sync",
        start: "Stopped",
        closed: "Error: watcher close failed",
        done: "clean",
      },
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
        // How the start settled, and its `done`.
        const { stop, scope, watching } =
          unit === "watchCatalogs"
            ? yield* launchWatch(project, options)
            : yield* launchFollow(project, options);
        const settles = Fiber.await<{ readonly _tag: string; readonly done: Effect.Effect<void> }, never>(
          watching
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
          start: Exit.isSuccess(settled) ? settled.value._tag : String(Cause.squash(settled.cause)),
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
// test clock, so nothing in a start waits on the event loop (a read in Node's thread pool, a timer) and every run of a
// sweep takes the same steps, however loaded the machine. The suite keeps the timeout of `watch-lifecycle.test.ts`'s
// suite it came from.
describe.for(["watchCatalogs", "followConfig"])(
  "a caller scope that closes before or during %s's start",
  { timeout: 20_000 },
  (start) => {
    function watchIn(project: Project, scope: Scope.Scope, events: Layer.Layer<FileEvents>) {
      const output = { report: () => Effect.void, ready: Effect.void };
      const path = project.path("elmera-intl.json");

      // How the start settled, and its `done`.
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
            ).pipe(Effect.map(({ _tag, done }) => ({ settled: _tag, done })))
          : readConfigSnapshot(path).pipe(
              Effect.flatMap((first) =>
                followConfig(path, first, { _tag: "native" }, Deferred.makeUnsafe<void>(), output)
              ),
              Effect.map(({ _tag, done }) => ({ settled: _tag, done }))
            );

      return starting.pipe(Scope.provide(scope), Effect.provide([syncCatalogServices(), events]));
    }

    // With the scheduler yielding after each number of operations a budget allows, the start is interrupted after each
    // number of its yields in turn, until it has ended before that, and then the scope closes: an interrupted start
    // takes nothing, so wherever the interruption lands the close settles, clean, with every watcher closed. Each
    // budget lines the interruptions up with the start's steps differently: in `followConfig`'s start, 1, 4 and 8 each
    // land one between a claim on the follow's end and its release (`handOff` in watch.ts), which, left interruptible,
    // leaves the close waiting for ever. They are an alignment with the start's steps as they are now; a change to them
    // can move it, so check them by making that step interruptible and seeing each hang.
    it.for([1, 4, 8])(
      "settles the close wherever an interruption lands in the start, yielding every %i operations",
      async (budget, { project }) => {
        const events = deliveredEvents();
        const sweep = Effect.gen(function* () {
          const unsettled: Array<number> = [];

          for (let yields = 0; yields < 1_000; yields += 1) {
            const scope = yield* Scope.make();
            const starting = yield* Effect.forkDetach(watchIn(project, scope, events.layer));

            for (let turn = 0; turn < yields; turn += 1) {
              yield* Effect.yieldNow;
            }

            const startedFirst = starting.pollUnsafe() !== undefined;
            yield* Fiber.interrupt(starting);
            const closed = yield* Effect.exit(Scope.close(scope, Exit.void));

            if (Exit.isFailure(closed) || events.open().length > 0) {
              unsettled.push(yields);
            }

            if (startedFirst) {
              return { swept: yields > 0, unsettled };
            }
          }

          return { swept: false, unsettled };
        }).pipe(
          Effect.provideService(References.MaxOpsBeforeYield, budget),
          Effect.provide(TestClock.layer())
        );

        expect(await project.within(Effect.runPromise(sweep), "the sweep")).toEqual({
          swept: true,
          unsettled: [],
        });
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

      // A scope closed before the start is no failure: the start is stopped, and its end clean.
      expect([
        Exit.isSuccess(exit) ? exit.value : exit,
        events.calls(),
        events.open(),
        existsSync(project.path("messages/nb.po")),
      ]).toEqual([["Stopped", Exit.void], 0, [], false]);
    });

    // With the scheduler yielding after every operation, the close lands after each number of the start's yields in
    // turn, until the start has ended before it.
    it("settles its start and the close wherever the close lands in the start", async ({ project }) => {
      const events = deliveredEvents();
      const sweep = Effect.gen(function* () {
        const unsettled: Array<number> = [];

        for (let yields = 0; yields < 1_000; yields += 1) {
          const scope = yield* Scope.make();
          const starting = yield* Effect.forkDetach(watchIn(project, scope, events.layer));

          for (let turn = 0; turn < yields; turn += 1) {
            yield* Effect.yieldNow;
          }

          const startedFirst = starting.pollUnsafe() !== undefined;
          const closed = yield* Effect.exit(Scope.close(scope, Exit.void));
          const exit = yield* Fiber.await(starting);
          // Wherever the close lands, the start is ready (it settled before the close) or stopped, never failed, and
          // the close and the watch's end are clean.
          const ended = Exit.isSuccess(exit) ? yield* Effect.exit(exit.value.done) : exit;

          if (
            !Exit.isSuccess(exit) ||
            !["Started", "Ready", "Stopped"].includes(exit.value.settled) ||
            Exit.isFailure(closed) ||
            Exit.isFailure(ended) ||
            events.open().length > 0
          ) {
            unsettled.push(yields);
          }

          if (startedFirst) {
            return { swept: yields > 0, unsettled };
          }
        }

        return { swept: false, unsettled };
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 1), Effect.provide(TestClock.layer()));

      expect(await project.within(Effect.runPromise(sweep), "the sweep")).toEqual({
        swept: true,
        unsettled: [],
      });
    });
  }
);

// Unit under test: `followConfig`'s ownership of its watches' scopes: the follow's own scope closes its finalizers in
// order, its release before the scope that holds its watches, so a close of the caller's scope from another fiber never
// closes a watch's scope before the follow's loop does. Oracle: the contract by hand: wherever such a close lands in
// the start, the start ends as one of the outcomes below, and the close and the follow's end settle clean, with every
// watcher closed; the sweep reaches the outcomes on each side of the start's claim. It goes red when those finalizers
// run in parallel (start `Stopped`, close `EACCES`). It does not guard where the startup latch opens: on this scheduler
// the follow reaches no watch in the few steps between the release's registration and the start's claim, so the sweep
// passes with the latch opened before the claim, or with no latch (the last test here guards that). Each sweep runs on
// the synchronous file system and the test clock with every fiber yielding after each operation, so every run takes the
// same steps (see the sweeps above); fresh file events each offset, since a refused tree refuses once.
describe("followConfig's start, the caller's scope closed from another fiber", { timeout: 20_000 }, () => {
  // A first tree refused, its cleanup held. Closed before the start claims the follow's end: stopped, no tree opened.
  // After the refusal: the refusal's own failure, which the start takes, never the close. Closed as its trees open
  // (`also`): stopped, the tree it opened closed, as `Following` says of a stop that came first with no watch halted on
  // its own; allowed, not required, since it depends on where the trees' steps fall. (A started generation with an
  // empty mailbox is the close sweep's last offset above.)
  const reached = [
    { start: "Error: EACCES: permission denied, watch", closed: "clean", done: undefined, opened: true },
    { start: "Stopped", closed: "clean", done: "clean", opened: false },
  ];
  const also = [{ start: "Stopped", closed: "clean", done: "clean", opened: true }];

  it("ends the start as an allowed outcome wherever the close lands, on a refused first tree", async ({
    project,
  }) => {
    const path = project.path("elmera-intl.json");
    const output = { report: () => Effect.void, ready: Effect.void };
    // An outcome as text, to compare.
    const keyOf = (each: { start: string; closed: string; done: string | undefined; opened: boolean }) =>
      [each.start, each.closed, String(each.done), String(each.opened)].join(" | ");
    const sweep = Effect.gen(function* () {
      // Each outcome reached, as text.
      const seen = new Set<string>();
      const unsettled: Array<number> = [];
      // The offset from which the start had settled, or its refused tree's cleanup begun, before the close.
      let past: number | undefined;

      for (let yields = 0; yields < 1_000 && (past === undefined || yields < past + 10); yields += 1) {
        const held = Promise.withResolvers<void>();
        const cleanup = { begun: false };
        const events = twoTrees(project, {
          opening: refusedOnce(project, "src"),
          releasing: () => {
            cleanup.begun = true;

            return held.promise;
          },
        });
        const scope = yield* Scope.make();
        const starting = yield* readConfigSnapshot(path).pipe(
          Effect.flatMap((first) => followConfig(path, first, NATIVE, Deferred.makeUnsafe<void>(), output)),
          Scope.provide(scope),
          Effect.provide([syncCatalogServices(), events.layer]),
          Effect.forkDetach
        );

        for (let turn = 0; turn < yields; turn += 1) {
          yield* Effect.yieldNow;
        }

        if (past === undefined && (starting.pollUnsafe() !== undefined || cleanup.begun)) {
          past = yields;
        }

        const closing = yield* Effect.forkDetach(ending(Scope.close(scope, Exit.void)));
        yield* Effect.yieldNow;
        held.resolve();
        const closed = yield* Fiber.join(closing);
        const exit = yield* Fiber.await(starting);
        const settled = {
          start: Exit.isSuccess(exit) ? exit.value._tag : String(Cause.squash(exit.cause)),
          closed,
          done: Exit.isSuccess(exit) ? yield* ending(exit.value.done) : undefined,
          opened: events.calls() > 0,
        };
        seen.add(keyOf(settled));

        if (
          ![...reached, ...also].some((each) => keyOf(each) === keyOf(settled)) ||
          events.open().length > 0
        ) {
          unsettled.push(yields);
        }
      }

      return { missed: reached.map((each) => keyOf(each)).filter((key) => !seen.has(key)), unsettled };
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 1), Effect.provide(TestClock.layer()));

    expect(await project.within(Effect.runPromise(sweep), "the sweep")).toEqual({
      missed: [],
      unsettled: [],
    });
  });

  // The latch's placement: the start's fiber stands still after each number of its operations in turn (the scheduler
  // parks its continuation), every other fiber running on until all are suspended, and then the caller's scope closes.
  // Parked between registering its release and claiming its end, the start has opened no latch, so the follow has
  // begun no watch, and the close finds it stopped; never the close taking the refusal's failure. Red with the latch
  // opened before the claim (start `Stopped`, close `EACCES`).
  it("never hands the close a start's failure wherever the start stands still", async ({ project }) => {
    const path = project.path("elmera-intl.json");
    const output = { report: () => Effect.void, ready: Effect.void };
    const inner = new Scheduler.MixedScheduler();
    const shared = inner.makeDispatcher();
    // Tasks queued and not yet run, a parked one aside.
    let pending = 0;
    // Until every fiber has stayed suspended for two turns of the event loop.
    const idle = Effect.gen(function* () {
      for (let quiet = 0; quiet < 2; quiet = pending === 0 ? quiet + 1 : 0) {
        yield* Effect.callback<void>((resume) => {
          setImmediate(() => resume(Effect.void));
        });
      }
    });
    // A scheduler that parks its target's continuation after `ops` operations; every other task runs as queued.
    const parking = (ops: number) => {
      // The fiber to park, set once it is forked; how many operations it has run; whether its next task parks.
      const target = new Set<Fiber.Fiber<unknown, unknown>>();
      const park = { counted: 0, next: false };
      const parked: Array<() => void> = [];
      const scheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: (fiber) => {
          park.next = target.has(fiber) && (park.counted += 1) === ops;

          return park.next || inner.shouldYield(fiber);
        },
        makeDispatcher: () => ({
          scheduleTask: (task, priority) => {
            if (park.next) {
              park.next = false;
              parked.push(task);
            } else {
              pending += 1;
              shared.scheduleTask(() => {
                pending -= 1;
                task();
              }, priority);
            }
          },
          flush: () => shared.flush(),
        }),
      };

      return { target, parked, scheduler };
    };
    const sweep = Effect.gen(function* () {
      const outcomes = new Set<string>();

      for (let ops = 1; ops < 2_000; ops += 1) {
        const held = Promise.withResolvers<void>();
        const events = twoTrees(project, {
          opening: refusedOnce(project, "src"),
          releasing: () => held.promise,
        });
        const { target, parked, scheduler } = parking(ops);
        const scope = yield* Scope.make();
        const starting = yield* readConfigSnapshot(path).pipe(
          Effect.flatMap((first) => followConfig(path, first, NATIVE, Deferred.makeUnsafe<void>(), output)),
          Scope.provide(scope),
          Effect.provide([syncCatalogServices(), events.layer]),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkDetach
        );
        target.add(starting);
        yield* idle;

        if (parked.length === 0) {
          break;
        }

        const closing = yield* Effect.forkDetach(ending(Scope.close(scope, Exit.void)));
        yield* idle;
        held.resolve();
        yield* idle;
        parked.splice(0).forEach((task) => shared.scheduleTask(task, 0));
        const closed = yield* Fiber.join(closing);
        const exit = yield* Fiber.await(starting);
        outcomes.add(
          `${Exit.isSuccess(exit) ? exit.value._tag : String(Cause.squash(exit.cause))}, close ${closed}`
        );
      }

      return [...outcomes].toSorted();
    });

    expect(await project.within(Effect.runPromise(sweep), "the sweep")).toEqual([
      "Error: EACCES: permission denied, watch, close clean",
      "Stopped, close clean",
    ]);
  });
});
