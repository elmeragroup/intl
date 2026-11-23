import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, mkdirSync } from "node:fs";

import type { ExtractOptions } from "../src/commands";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import type { SyncResult, Watching, WatchMode, WatchOutput } from "../src/watch";
import { CatalogSync, watchCatalogs } from "../src/watch";
import type { TreeListener } from "../src/watch-trees";
import { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import type { DeliveredEvents } from "./watch-project";
import { component, deliveredEvents, it, lockedRoot, POLLING, projectConfig, syncing } from "./watch-project";

// The watch's timing on the test clock: it polls a real tree every 50 ms, so a change is seen at the next poll and its
// sync starts after the 100 ms debounce, with no real timer. Unit under test: `watchCatalogs`. Oracle: the contract
// per case, by hand: one sync per burst, a debounce after its last change; syncs one at a time, with every change made
// during one starting exactly one more; a superseded sync re-armed without a change; a catalog the watch wrote starts
// no sync; a change made during the first sync is seen; a closed watch syncs no more.
describe("extract --watch on the test clock", () => {
  type Run = {
    readonly reports: Array<SyncResult["_tag"]>;
    readonly stop: Deferred.Deferred<void>;
    /** The watch's own scope, inside the test's. */
    readonly scope: Scope.Closeable;
    readonly watching: Watching;
  };

  // Native file events, which a test delivers itself through `deliveredEvents`.
  const NATIVE: WatchMode = { _tag: "native" };

  // Starts `effect` from a sleep the test clock wakes, so the clock waits until everything it sets off (the classifying
  // of a backlog, a sync) has suspended before it moves on. Returns the fiber that finishes it.
  const wake = Effect.fnUntraced(function* <A, E>(effect: Effect.Effect<A, E>) {
    // oxlint-disable-next-line tests/no-fixed-delay -- a test-clock sleep, woken by the TestClock.adjust below: no real time passes.
    const running = yield* Effect.sleep("1 millis").pipe(Effect.andThen(effect), Effect.forkChild);
    yield* TestClock.adjust("1 millis");

    return running;
  });
  // Runs `effect` from a test-clock wake (see `wake`).
  const woken = <A>(effect: Effect.Effect<A>) =>
    wake(effect).pipe(Effect.flatMap((fiber) => Fiber.join(fiber)));

  type Options = {
    /** The sync step; `extractCatalogs` unless a test holds or changes it. */
    readonly layer?: Layer.Layer<CatalogSync>;
    /** Writes each result; records its tag unless a test writes it. */
    readonly report?: (result: SyncResult) => Effect.Effect<void>;
    /** The watch's clock; the test clock unless a test moves the wall clock alone. */
    readonly clock?: Clock.Clock;
    /** Where change events come from; the poll unless a test delivers native events itself. */
    readonly mode?: WatchMode;
    /** The native file events; Node's unless a test delivers them itself. */
    readonly events?: Layer.Layer<FileEvents>;
    /** How the watch's caller scope runs its finalizers; sequential unless a test closes it in parallel. */
    readonly strategy?: "sequential" | "parallel";
    /** The stop signal; a new one unless a test gives it before the watch starts or as its trees open. */
    readonly stop?: Deferred.Deferred<void>;
  };

  // Starts the watch in a scope of its own inside the test's, with its sync step built in that scope so it lives as long
  // as the watch. It starts from a test-clock wake, so its poll and its debounce time from 1 ms. Returns once the start
  // has run up to its first suspension (a held first sync), with the fiber that finishes it.
  const launch = Effect.fnUntraced(function* (project: Project, options: Options = {}) {
    const reports: Array<SyncResult["_tag"]> = [];
    const scope = yield* Scope.fork(yield* Effect.scope, options.strategy ?? "sequential");
    const stop = options.stop ?? (yield* Deferred.make<void>());
    const services = yield* Layer.buildWithScope(
      Layer.merge(options.layer ?? CatalogSync.layer(), options.events ?? FileEvents.layer()),
      scope
    );
    const output: WatchOutput<never> = {
      report:
        options.report ??
        ((result) =>
          Effect.sync(() => {
            reports.push(result._tag);
          })),
      ready: Effect.void,
    };
    const starting = watchCatalogs(projectConfig(project), options.mode ?? POLLING, stop, output).pipe(
      Scope.provide(scope),
      Effect.provideContext(services)
    );
    const clocked =
      options.clock === undefined
        ? starting
        : starting.pipe(Effect.provideService(Clock.Clock, options.clock));
    const watching = yield* wake(clocked);

    return { reports, stop, scope, watching };
  });
  // Starts the watch (see `launch`) and waits for its start.
  const start = Effect.fnUntraced(function* (project: Project, options: Options = {}) {
    const { watching, ...run } = yield* launch(project, options);

    return { ...run, watching: yield* Fiber.join(watching) } satisfies Run;
  });

  // The sync step: `extractCatalogs`, its `hold`th call waiting for `gate` after its writes. `calls()` counts the calls.
  function holding(gate: Deferred.Deferred<void>, hold = 2) {
    let calls = 0;
    const layer = Layer.succeed(CatalogSync, {
      extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
        calls += 1;
        const result = extractCatalogs(config, options);

        if (calls === hold) {
          yield* Deferred.await(gate);
        }

        return result;
      }),
    });

    return { layer, calls: () => calls };
  }

  // The test clock, counting the sleeps of `ms` the watch takes (its debounce's, for DEBOUNCE_MS).
  const counting = Effect.fnUntraced(function* (ms: number) {
    const testClock = yield* Clock.Clock;
    let sleeps = 0;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe(),
      currentTimeMillis: testClock.currentTimeMillis,
      currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe(),
      currentTimeNanos: testClock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => testClock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: testClock.monotonicTimeNanos,
      sleep: (duration) => {
        if (Duration.toMillis(duration) === ms) {
          sleeps += 1;
        }

        return testClock.sleep(duration);
      },
    };

    return { clock, sleeps: () => sleeps };
  });

  // The sync step: `extractCatalogs`, dying on its `call`th call.
  function dying(call: number) {
    let calls = 0;

    return syncing((config, options) => {
      calls += 1;

      if (calls === call) {
        throw new Error("extract died");
      }

      return extractCatalogs(config, options);
    });
  }

  // The sync step: `extractCatalogs`, counting its calls.
  function counted() {
    let calls = 0;
    const layer = syncing((config, options) => {
      calls += 1;

      return extractCatalogs(config, options);
    });

    return { layer, calls: () => calls };
  }

  // Closes the watch's scope while `gate` holds a sync: the close is still pending a turn later, and ends once the sync
  // is released.
  const closeWhileHeld = (scope: Scope.Closeable, gate: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      const close = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Effect.yieldNow;
      expect(close.pollUnsafe()).toBeUndefined();

      return close;
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.flatMap((fiber) => Fiber.join(fiber))
    );

  // Closes the watch's scope while `gate` holds a sync: its watchers are already closed while the close is pending, so an
  // error the platform then delivers on `listener` is not admitted. The close ends once the sync is released.
  const closeWatchersFirst = (
    scope: Scope.Closeable,
    gate: Deferred.Deferred<void>,
    events: DeliveredEvents,
    listener: TreeListener
  ) =>
    Effect.gen(function* () {
      const closing = yield* wake(Scope.close(scope, Exit.void));
      expect([closing.pollUnsafe(), events.open()]).toEqual([undefined, []]);
      listener.error(new Error("EMFILE: too many open files"));

      return closing;
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.flatMap((fiber) => Fiber.join(fiber))
    );

  it.effect("folds a burst into one sync, a debounce after its last change", ({ project }) =>
    Effect.gen(function* () {
      const { reports } = yield* start(project);
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("50 millis");
      project.write("src/b.tsx", component("B"));
      yield* TestClock.adjust("50 millis");
      // b was seen at 100 ms, so the sync is due at 200 ms.
      yield* TestClock.adjust("99 millis");
      expect(reports).toEqual(["Written"]);

      yield* TestClock.adjust("1 millis");
      expect(reports).toEqual(["Written", "Written"]);
      expect(project.read("messages/nb.po")).toContain(`msgid "B"`);
    })
  );

  it.effect("runs one sync at a time, and starts one more for every change made during it", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      let running = 0;
      let overlapped = false;
      const { reports } = yield* start(project, {
        layer: Layer.succeed(CatalogSync, {
          extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            calls += 1;
            overlapped ||= running > 0;
            running += 1;
            const result = extractCatalogs(config, options);

            // The second sync holds, after its writes, until the test releases it.
            if (calls === 2) {
              yield* Deferred.await(gate);
            }

            running -= 1;

            return result;
          }),
        }),
      });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      expect(calls).toBe(2);

      // Three changes while the sync holds, each a quiet debounce after the one before.
      project.write("src/b.tsx", component("B"));
      yield* TestClock.adjust("300 millis");
      project.write("src/c.tsx", component("C"));
      yield* TestClock.adjust("300 millis");
      project.write("src/d.tsx", component("D"));
      yield* TestClock.adjust("300 millis");
      expect(calls).toBe(2);

      yield* woken(Deferred.succeed(gate, undefined));
      yield* TestClock.adjust("1 second");
      expect({ calls, overlapped, reports }).toEqual({
        calls: 3,
        overlapped: false,
        reports: ["Written", "Written", "Written"],
      });
      expect(project.read("messages/nb.po")).toContain(`msgid "D"`);
    })
  );

  it.effect("syncs again a debounce after a superseded sync, with no change", ({ project }) =>
    Effect.gen(function* () {
      let calls = 0;
      const { reports } = yield* start(project, {
        layer: syncing((config, options) => {
          calls += 1;

          return calls === 1
            ? { problems: [], messages: 0, written: [], superseded: true }
            : extractCatalogs(config, options);
        }),
      });
      yield* TestClock.adjust("99 millis");
      expect(reports).toEqual(["Superseded"]);

      yield* TestClock.adjust("1 millis");
      expect(reports).toEqual(["Superseded", "Written"]);
    })
  );

  it.effect(
    "starts no sync for the catalogs it wrote, and one for a catalog saved over them",
    ({ project }) =>
      Effect.gen(function* () {
        const { reports } = yield* start(project);
        yield* TestClock.adjust("1 second");
        expect(reports).toEqual(["Written"]);

        project.write(
          "messages/nb.po",
          project.read("messages/nb.po").replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
        );
        yield* TestClock.adjust("1 second");
        expect(reports).toEqual(["Written", "Unchanged"]);
      })
  );

  it.effect("sees a change made during the first sync", ({ project }) =>
    Effect.gen(function* () {
      let calls = 0;
      const { reports } = yield* start(project, {
        layer: syncing((config, options) => {
          calls += 1;
          const result = extractCatalogs(config, options);

          if (calls === 1) {
            project.write("src/during.tsx", component("During"));
          }

          return result;
        }),
      });
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written", "Written"]);
      expect(project.read("messages/nb.po")).toContain(`msgid "During"`);
    })
  );

  // The executable's drain on a signal, with a sync step that suspends (as the commands' will): stopping while a sync
  // runs waits for it, and its result is reported.
  it.effect("reports a sync running when the watch stops, and syncs no more", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      const { reports, stop, watching } = yield* start(project, {
        layer: Layer.succeed(CatalogSync, {
          extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            calls += 1;

            if (calls === 2) {
              yield* Deferred.await(gate);
            }

            return extractCatalogs(config, options);
          }),
        }),
      });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      expect(calls).toBe(2);

      // The stop reaches the held sync, and waits for it, before the sync is released.
      yield* Deferred.succeed(stop, undefined);
      const stopping = yield* Effect.forkChild(watching.done);
      yield* Effect.yieldNow;
      expect(stopping.pollUnsafe()).toBeUndefined();
      project.write("src/b.tsx", component("B"));
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(stopping);
      yield* TestClock.adjust("1 second");
      expect({ calls, reports }).toEqual({ calls: 2, reports: ["Written", "Written"] });
      expect(project.read("messages/nb.po")).toContain(`msgid "A"`);
    })
  );

  // The stop gate: from the stop on, no change is accepted, before anything waits for the watch to end.
  it.effect("accepts no change after the stop", ({ project }) =>
    Effect.gen(function* () {
      const { reports, stop } = yield* start(project);
      yield* Deferred.succeed(stop, undefined);
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written"]);
      expect(project.read("messages/nb.po")).not.toContain(`msgid "A"`);
    })
  );

  it.effect("drops a pending sync when the watch stops", ({ project }) =>
    Effect.gen(function* () {
      const { reports, stop, watching } = yield* start(project);
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("50 millis");
      yield* Deferred.succeed(stop, undefined);
      yield* watching.done;
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written"]);
      expect(project.read("messages/nb.po")).not.toContain(`msgid "A"`);
    })
  );

  // A sync held after its writes: what the poll sees meanwhile is classified only once the sync has recorded its writes.
  it.effect("starts no sync for its own write while a sync is held", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const { reports } = yield* start(project, { layer: sync.layer });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("1 second");
      expect(sync.calls()).toBe(2);

      yield* woken(Deferred.succeed(gate, undefined));
      yield* TestClock.adjust("1 second");
      expect({ calls: sync.calls(), reports }).toEqual({ calls: 2, reports: ["Written", "Written"] });
    })
  );

  // A translator's editor saves the catalog back to its text from before the held sync: compared with what the last
  // sync wrote, that is a change, so the message the held sync added comes back.
  it.effect("syncs a catalog saved back to its earlier text while a sync is held", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const { reports } = yield* start(project, { layer: sync.layer });
      const before = project.read("messages/nb.po");
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      expect(project.read("messages/nb.po")).toContain(`msgid "A"`);

      project.write("messages/nb.po", before);
      yield* TestClock.adjust("1 second");
      yield* woken(Deferred.succeed(gate, undefined));
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written", "Written", "Written"]);
      expect(project.read("messages/nb.po")).toContain(`msgid "A"`);
    })
  );

  // The follow-up of a held sync is debounced from when the sync ends, so a save just after it joins the same sync.
  it.effect("waits a debounce after a held sync before its follow-up", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const { reports } = yield* start(project, { layer: sync.layer });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      project.write("src/b.tsx", component("B"));
      yield* TestClock.adjust("400 millis");

      yield* woken(Deferred.succeed(gate, undefined));
      yield* TestClock.adjust("20 millis");
      project.write("src/c.tsx", component("C"));
      yield* TestClock.adjust("1 second");
      expect({ calls: sync.calls(), reports }).toEqual({
        calls: 3,
        reports: ["Written", "Written", "Written"],
      });
      expect(project.read("messages/nb.po")).toContain(`msgid "C"`);
    })
  );

  // A catalog saved right after the sync wrote it, inside the sync step: the record is the text the sync wrote, not
  // what the file holds once the step returns, so the save is a change, and its problem is reported.
  it.effect("syncs a catalog saved right after the sync wrote it", ({ project }) =>
    Effect.gen(function* () {
      let calls = 0;
      const { reports } = yield* start(project, {
        layer: syncing((config, options) => {
          calls += 1;
          const result = extractCatalogs(config, options);

          if (calls === 1) {
            project.write("messages/nb.po", `${project.read("messages/nb.po")}msgid "Broken\n`);
          }

          return result;
        }),
      });
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written", "Failed"]);
    })
  );

  // A result that cannot be written, nor its SyncFailed after it, ends the watch: the edit still debouncing is dropped,
  // and the watch ends with the write's failure.
  it.effect("drops a pending sync when a write fails for good", ({ project }) =>
    Effect.gen(function* () {
      let calls = 0;
      const layer = syncing((config, options) => {
        calls += 1;

        return extractCatalogs(config, options);
      });
      const { watching } = yield* start(project, {
        layer,
        report: (result) => (result._tag === "Failed" ? Effect.die(new Error("stderr gone")) : Effect.void),
      });
      // The edit is seen a poll before the lock, so its sync is pending, its debounce running, when the write fails.
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("50 millis");
      project.lock("src/locked");
      yield* TestClock.adjust("1 second");
      const exit = yield* Effect.exit(watching.done);

      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("stderr gone"));
      expect(calls).toBe(1);
      expect(project.read("messages/nb.po")).not.toContain(`msgid "A"`);
    })
  );

  // The poll's first interval runs from its first walk, taken before the first sync: a slow first sync does not push the
  // next walk back, so a save made during it is synced a debounce after the first sync ends.
  it.effect(
    "times the first poll from the first walk, not from the end of a slow first sync",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sync = holding(gate, 1);
        const { reports, watching } = yield* launch(project, { layer: sync.layer });
        // The first walk was taken at 1 ms; the first sync holds.
        project.write("src/a.tsx", component("A"));
        yield* TestClock.adjust("50 millis");
        // Released at 52 ms: the walk at 51 ms saw the save, so its sync is due at 152 ms.
        yield* woken(Deferred.succeed(gate, undefined));
        yield* Fiber.join(watching);
        yield* TestClock.adjust("99 millis");
        expect(reports).toEqual(["Written"]);

        yield* TestClock.adjust("1 millis");
        expect(reports).toEqual(["Written", "Written"]);
        expect(project.read("messages/nb.po")).toContain(`msgid "A"`);
      })
  );

  // The watch's own scope closing stops it as a signal does: the close waits for the held sync and writes its result,
  // and nothing syncs after it.
  it.effect("reports a sync running when its scope closes, and closes only after it", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const { reports, scope } = yield* start(project, { layer: sync.layer });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      expect(sync.calls()).toBe(2);

      yield* closeWhileHeld(scope, gate);
      project.write("src/b.tsx", component("B"));
      yield* TestClock.adjust("1 second");
      expect({ calls: sync.calls(), reports }).toEqual({ calls: 2, reports: ["Written", "Written"] });
      expect(project.read("messages/nb.po")).toContain(`msgid "A"`);
    })
  );

  // The stop owns the first sync too: the watch's scope closing while it runs waits for it and writes its result.
  it.effect(
    "reports the first sync when its scope closes during it, and closes only after it",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sync = holding(gate, 1);
        const { reports, scope } = yield* launch(project, { layer: sync.layer });
        expect(sync.calls()).toBe(1);

        yield* closeWhileHeld(scope, gate);
        expect(reports).toEqual(["Written"]);
        expect(project.read("messages/nb.po")).toContain(`msgid "Hello"`);
      })
  );

  // A stop during the first sync closes the watchers at once, then waits for the sync and writes its result.
  it.effect("closes its watchers at a stop during the first sync, then reports that sync", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate, 1);
      const events = deliveredEvents();
      const { reports, stop, watching } = yield* launch(project, {
        layer: sync.layer,
        mode: NATIVE,
        events: events.layer,
      });
      expect([sync.calls(), events.open()]).toEqual([1, [project.root]]);

      yield* woken(Deferred.succeed(stop, undefined));
      expect([events.open(), reports]).toEqual([[], []]);

      yield* woken(Deferred.succeed(gate, undefined));
      yield* Fiber.join(watching);
      yield* TestClock.adjust("1 second");
      expect(reports).toEqual(["Written"]);
    })
  );

  // A save that lands right after the sync's writes, inside the sync step: the next sync merges it rather than writing
  // the PO it read before.
  it.effect("keeps a msgstr saved right after the sync that added its message", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* start(project, {
        layer: syncing((config, options) => {
          const result = extractCatalogs(config, options);
          const added = result.written.find(
            ({ path, text }) => path === po && text.includes(`msgid "Ready"`)
          );

          if (!saved && added !== undefined) {
            saved = true;
            project.write(
              "messages/nb.po",
              added.text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
            );
          }

          return result;
        }),
      });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);

      project.write("src/after.tsx", component("After"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "After"`);
    })
  );

  // A save that lands after a sync read the PO and before it writes: the sync yields, and the next one merges the save.
  it.effect("keeps a msgstr saved while a sync runs", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* start(project, {
        layer: syncing((config, options) => {
          const plan = planCatalogs(config, options);

          if (
            !saved &&
            plan.outputs.some(({ path, text }) => path === po && text.includes(`msgid "Ready"`))
          ) {
            saved = true;
            project.write(
              "messages/nb.po",
              project
                .read("messages/nb.po")
                .replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
            );
          }

          return writeCatalogs(plan, options);
        }),
      });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Hello"\nmsgstr "Hei"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"`);
    })
  );

  // The watch's own scope closing stops it in order, whatever stage it is in: its watchers close first, while the sync
  // still holds, so an error the platform already dispatched is not admitted; then the sync finishes and its result is
  // written.
  it.effect(
    "closes its watchers first when its scope closes during a sync, and admits nothing after",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sync = holding(gate);
        const events = deliveredEvents();
        const { reports, scope } = yield* start(project, {
          layer: sync.layer,
          mode: NATIVE,
          events: events.layer,
        });
        const listener = events.listener(project.root);
        project.write("src/a.tsx", component("A"));
        listener.change("rename", "src/a.tsx");
        yield* TestClock.adjust("150 millis");
        expect(sync.calls()).toBe(2);

        yield* closeWatchersFirst(scope, gate, events, listener);
        expect(reports).toEqual(["Written", "Written"]);
      })
  );

  it.effect(
    "closes its watchers first when its scope closes during the first sync, then reports it",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sync = holding(gate, 1);
        const events = deliveredEvents();
        const { reports, scope } = yield* launch(project, {
          layer: sync.layer,
          mode: NATIVE,
          events: events.layer,
        });
        const listener = events.listener(project.root);

        yield* closeWatchersFirst(scope, gate, events, listener);
        expect(reports).toEqual(["Written"]);
      })
  );

  // The watch owns its stop's order: a caller scope that closes its finalizers in parallel still gets the drain.
  it.effect("reports a held sync when a parallel caller scope closes", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const { reports, scope } = yield* start(project, { layer: sync.layer, strategy: "parallel" });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("150 millis");
      expect(sync.calls()).toBe(2);

      yield* closeWhileHeld(scope, gate);
      expect(reports).toEqual(["Written", "Written"]);
    })
  );

  // `done` reports the stop whatever stopped the watch: its scope closing included.
  it.effect("ends `done` when its scope closes", ({ project }) =>
    Effect.gen(function* () {
      const { scope, watching } = yield* start(project);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Effect.exit(watching.done);

      expect(exit).toEqual(Exit.void);
    })
  );

  // The start is the stop's too: a stop before it, or during it, ends it only once the stop has run, with no first sync,
  // nothing reported and no watcher left open; a failure the stop ends with (a write that failed for good, a watcher that
  // failed to close) fails the start. Oracle: that contract, by hand, per case.
  it.effect("opens no tree and reports nothing when stopped before it starts", ({ project }) =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      yield* Deferred.succeed(stop, undefined);
      const sync = counted();
      const events = deliveredEvents();
      const { reports, watching } = yield* start(project, {
        layer: sync.layer,
        mode: NATIVE,
        events: events.layer,
        stop,
      });
      yield* watching.done;
      yield* TestClock.adjust("1 second");

      expect({
        opened: events.calls(),
        syncs: sync.calls(),
        reports,
        written: existsSync(project.path("messages/nb.po")),
      }).toEqual({ opened: 0, syncs: 0, reports: [], written: false });
    })
  );

  it.effect(
    "walks no tree and reports nothing when stopped before it starts, a tree unreadable",
    ({ project }) =>
      Effect.gen(function* () {
        lockedRoot(project);
        const stop = yield* Deferred.make<void>();
        yield* Deferred.succeed(stop, undefined);
        const sync = counted();
        const { reports, watching } = yield* start(project, { layer: sync.layer, stop });
        yield* watching.done;
        yield* TestClock.adjust("1 second");

        expect({ syncs: sync.calls(), reports, written: existsSync(project.path("messages/nb.po")) }).toEqual(
          {
            syncs: 0,
            reports: [],
            written: false,
          }
        );
      })
  );

  it.effect("runs no first sync when the stop lands during the start", ({ project }) =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const sync = counted();
      // The stop lands as the last tree opens: after the trees are watched, before the first sync.
      const events = deliveredEvents({
        opened: () => {
          Deferred.doneUnsafe(stop, Effect.void);
        },
      });
      const { reports, watching } = yield* start(project, {
        layer: sync.layer,
        mode: NATIVE,
        events: events.layer,
        stop,
      });
      yield* watching.done;
      yield* TestClock.adjust("1 second");

      expect({
        opened: events.calls(),
        open: events.open(),
        syncs: sync.calls(),
        reports,
        written: existsSync(project.path("messages/nb.po")),
      }).toEqual({ opened: 1, open: [], syncs: 0, reports: [], written: false });
    })
  );

  it.effect(
    "ends the start once its open trees are closed, when stopped while a tree still opens",
    ({ project }) =>
      Effect.gen(function* () {
        mkdirSync(project.path("messages"));
        const src = Promise.withResolvers<void>();
        const stop = yield* Deferred.make<void>();
        const events = deliveredEvents({
          opening: (dir) => (dir === project.path("src") ? src.promise : undefined),
          closeFails: new Error("close failed"),
        });
        const { watching } = yield* launch(project, { mode: NATIVE, events: events.layer, stop });
        // Before the watch's scope closes, should an assertion end the test first.
        yield* Effect.addFinalizer(() => Effect.sync(() => src.resolve()));
        expect([events.open(), events.opening()]).toEqual([[project.path("messages")], 1]);

        yield* Deferred.succeed(stop, undefined);
        const exit = yield* Fiber.await(watching);

        expect([Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, events.open()]).toEqual([
          new Error("close failed"),
          [],
        ]);
      })
  );

  it.effect("fails the start with a write that fails for good while a tree still opens", ({ project }) =>
    Effect.gen(function* () {
      mkdirSync(project.path("messages"));
      const src = Promise.withResolvers<void>();
      const events = deliveredEvents({
        opening: (dir) => (dir === project.path("src") ? src.promise : undefined),
      });
      const { watching } = yield* launch(project, {
        mode: NATIVE,
        events: events.layer,
        report: (result) => (result._tag === "Failed" ? Effect.die(new Error("stderr gone")) : Effect.void),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => src.resolve()));
      expect(events.open()).toEqual([project.path("messages")]);

      events.listener(project.path("messages")).error(new Error("EMFILE: too many open files"));
      const exit = yield* Fiber.await(watching);

      expect([Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, events.open()]).toEqual([
        new Error("stderr gone"),
        [],
      ]);
    })
  );

  it.effect("fails the start with the close failure of a watcher acquired as the stop lands", ({ project }) =>
    Effect.gen(function* () {
      const acquiring = Promise.withResolvers<void>();
      const stop = yield* Deferred.make<void>();
      const events = deliveredEvents({ acquiring: acquiring.promise, closeFails: new Error("close failed") });
      const { watching } = yield* launch(project, { mode: NATIVE, events: events.layer, stop });
      // Before the watch's scope closes, which waits for the acquire, should an assertion end the test first.
      yield* Effect.addFinalizer(() => Effect.sync(() => acquiring.resolve()));
      expect([events.open(), events.opening()]).toEqual([[], 1]);

      yield* Deferred.succeed(stop, undefined);
      yield* Effect.yieldNow;
      acquiring.resolve();
      const exit = yield* Fiber.await(watching);

      expect([Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, events.open()]).toEqual([
        new Error("close failed"),
        [],
      ]);
    })
  );

  // A defect in a sync is no lost worker: it stops the watch, and the start (for the first sync) or `done` (for a
  // later one) ends with it.
  it.effect("fails the start with a defect in the first sync", ({ project }) =>
    Effect.gen(function* () {
      const { watching } = yield* launch(project, { layer: dying(1) });
      const exit = yield* Fiber.await(watching);

      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("extract died"));
    })
  );

  it.effect("ends `done` with a defect in a later sync", ({ project }) =>
    Effect.gen(function* () {
      const { watching } = yield* start(project, { layer: dying(2) });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("1 second");
      const exit = yield* Effect.exit(watching.done);

      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("extract died"));
    })
  );

  // A burst that lands while a sync holds: every batch admitted meanwhile is one classification once the sync ends,
  // one trigger and one debounce, and exactly one follow-up sync.
  it.effect("folds a burst of 200 native events during a held sync into one follow-up", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sync = holding(gate);
      const events = deliveredEvents();
      const debounce = yield* counting(100);
      const { reports } = yield* start(project, {
        layer: sync.layer,
        mode: NATIVE,
        events: events.layer,
        clock: debounce.clock,
      });
      const listener = events.listener(project.root);
      project.write("src/a.tsx", component("A"));
      listener.change("change", "src/a.tsx");
      yield* TestClock.adjust("150 millis");
      expect(sync.calls()).toBe(2);

      project.write("src/b.tsx", component("B"));

      for (let event = 0; event < 200; event += 1) {
        listener.change("change", "src/b.tsx");
      }

      const before = debounce.sleeps();
      yield* woken(Deferred.succeed(gate, undefined));
      yield* TestClock.adjust("1 second");
      expect({ calls: sync.calls(), reports, sleeps: debounce.sleeps() - before }).toEqual({
        calls: 3,
        reports: ["Written", "Written", "Written"],
        sleeps: 1,
      });
    })
  );

  // The debounce is a relative sleep: the wall clock stepping back two minutes, just after a save is seen, does not
  // hold its sync back until the wall clock catches up.
  it.effect("syncs on time when the wall clock steps back", ({ project }) =>
    Effect.gen(function* () {
      const testClock = yield* Clock.Clock;
      let offset = 0;
      const wall: Clock.Clock = {
        currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe() - offset,
        currentTimeMillis: Effect.sync(() => testClock.currentTimeMillisUnsafe() - offset),
        currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe() - BigInt(offset) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => testClock.currentTimeNanosUnsafe() - BigInt(offset) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => testClock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: testClock.monotonicTimeNanos,
        sleep: (duration) => testClock.sleep(duration),
      };
      const { reports } = yield* start(project, { clock: wall });
      project.write("src/a.tsx", component("A"));
      yield* TestClock.adjust("50 millis");
      offset = 120_000;
      yield* TestClock.adjust("100 millis");
      expect(reports).toEqual(["Written", "Written"]);
    })
  );
});
