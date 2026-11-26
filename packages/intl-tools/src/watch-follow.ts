// `extract --watch` on a config it follows (#73): `watchCatalogs` (watch.ts) once per config text, one after another,
// each in a scope of its own with its own halt, run by one loop. One fiber rereads the config, and one fiber writes
// every output in order.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { basename } from "node:path";

import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";
import type { ConfigSnapshot } from "./project-config-read";
import { readConfigSnapshot } from "./project-config-read";
import type { Output, Watching, WatchMode, WatchOutput } from "./watch";
import { failed, handOff, watchCatalogs, writeResult } from "./watch";

// How often the follow reads the config when the trees take native events: often enough that an edit is followed
// before the next save that depends on it, and one small read a tick costs nothing beside a sync.
const CONFIG_READ_MS = 250;

/**
 * A followed watch whose start has ended (see `followConfig`); `done` waits for the follow to end, and ends as it did.
 * `Ready`: a first sync's result (or the config's problem) is written, no newer config waiting. `Stopped`: a stop came
 * first (the host's, or the caller's scope closing), which is not a failure, whatever the follow's end then is. The end
 * has one recipient: `done`, or the scope's close when it comes first, after which `done` ends clean.
 */
export type Following = { readonly _tag: "Ready" | "Stopped"; readonly done: Effect.Effect<void> };

// A watch the follow runs on one config, and who completed its halt (the host's stop, the follow), recorded in the
// step that completes it; never written when the watch halted on its own.
type Generation = {
  readonly scope: Scope.Closeable;
  readonly halt: Deferred.Deferred<void>;
  claimed: "host" | "follow" | undefined;
};

const haltedOnOwn = (generation: Generation) =>
  Deferred.isDoneUnsafe(generation.halt) && generation.claimed === undefined;

// The record is written before the halt completes, never after: completing it resumes its waiters at once, and the
// generation's whole stop, and the loop reading the record, can run inside that call.
const claim = (generation: Generation, by: "host" | "follow") =>
  Effect.sync(() => {
    if (!Deferred.isDoneUnsafe(generation.halt)) {
      generation.claimed = by;
      Deferred.doneUnsafe(generation.halt, Effect.void);
    }
  });

/**
 * `watchCatalogs` on the config at `path`, following its edits: one watch per config text, each in a scope of its own
 * with its own halt, run one after another by one loop. One fiber reads the config (`readConfigSnapshot`) each poll
 * interval, or each `CONFIG_READ_MS` on native events, after the previous read ends; a text other than the last read
 * is written as `ConfigChanged` at once and kept, the newest only, until the watch running or starting has ended.
 * Only a stop interrupts a start. A valid config starts a watch, which writes `Restarted` after its first sync's result
 * (the first to sync writes the ready line); an invalid one writes its problem; a watch that fails to start once the
 * follow has started writes `WatchFailed`.
 *
 * The start is `Ready` once an iteration has written its first result with no newer config waiting, and `Stopped` when
 * a stop came first unless a watch had halted on its own before it; otherwise it fails with a write that failed for
 * good, a defect, or the follow's end (a first watch that failed to start, nothing newer waiting; a watcher that failed
 * to close). One fiber makes every write, in order, a failed result written again as `SyncFailed`; one that fails too
 * ends the follow. The follow never completes `stop`. `done` (or the scope's close, when nothing takes it) ends with
 * the writer's failure, then a defect, then as the last watch ended.
 *
 * @param path - The config's absolute path.
 * @param first - The host's read of it, or none, for the follow to read it itself.
 * @param mode - Where change events come from.
 * @param stop - Done when the host wants the watch to stop.
 * @param output - Where the results are written, and the ready line after the first watch's first result.
 * @returns An effect that starts the followed watch in its scope, ending as its start did.
 */
export const followConfig = /* @__PURE__ */ Effect.fn("elmera-intl.watch.follow")(function* <R>(
  path: string,
  first: ConfigSnapshot | undefined,
  mode: WatchMode,
  stop: Deferred.Deferred<void>,
  output: WatchOutput<R>
) {
  const own = yield* Scope.fork(yield* Effect.scope, "sequential");
  const generations = yield* Scope.fork(own, "sequential");
  // The follow is ending: the host's stop, a fatal halt (its cause recorded in the same step) or the follow's end.
  const ending = yield* Deferred.make<void>();
  const ended = Deferred.await(ending);
  let writeFailure: Cause.Cause<never> | undefined;
  let defect: Cause.Cause<never> | undefined;
  const stopping = () => Deferred.isDoneUnsafe(stop) || Deferred.isDoneUnsafe(ending);
  const mailbox = yield* Queue.sliding<ConfigSnapshot>(1);
  const edited = Queue.peek(mailbox);
  const firstRead = yield* Deferred.make<ConfigSnapshot>();
  // Each write, with what its writer waits on: released once written, or once the writer has died.
  const writes = yield* Queue.unbounded<readonly [Output, Deferred.Deferred<void> | undefined], Cause.Done>();
  // Done once the loop settles the start as ready.
  const ready = yield* Deferred.make<void>();
  // Whether the host's stop stopped the start, recorded before the follow's end is: the start then leaves that end to
  // `done`.
  let stoppedByHost = false;
  const finished = yield* Deferred.make<void>();
  const outcome = handOff(Deferred.await(finished));
  // The first watch to write a first sync's result writes the ready line, every later one `Restarted`.
  let announced = false;

  const queued = (next: Output) =>
    Effect.suspend(() => {
      const written = Deferred.makeUnsafe<void>();

      return Queue.offerUnsafe(writes, [next, written]) ? Deferred.await(written) : Effect.void;
    });
  const generationOutput: WatchOutput<never> = {
    report: (result) => queued({ _tag: "Result", result }),
    ready: Effect.suspend(() => {
      const next: Output = announced ? { _tag: "Result", result: { _tag: "Restarted" } } : { _tag: "Ready" };
      announced = true;

      return queued(next);
    }),
  };
  const supervised = <A, X>(worker: Effect.Effect<A, never, X>) =>
    worker.pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          if (!Cause.hasInterruptsOnly(cause)) {
            defect ??= cause;
            Deferred.doneUnsafe(ending, Effect.void);
          }
        })
      )
    );
  // A write that fails for good ends the follow, recorded as it does, and releases every write waiting.
  const writeInOrder = Effect.gen(function* () {
    for (;;) {
      const [next, written] = yield* Queue.take(writes);
      const exit = yield* Effect.exit(
        (next._tag === "Ready" ? output.ready : writeResult(output, next.result)).pipe(Effect.uninterruptible)
      );

      if (Exit.isFailure(exit)) {
        writeFailure = exit.cause;
        Deferred.doneUnsafe(ending, Effect.void);
        yield* Queue.end(writes);
        yield* Queue.clear(writes).pipe(
          Effect.map((waiting) => [written, ...waiting.map(([, write]) => write)]),
          Effect.map((waiting) =>
            waiting.forEach((write) => write && Deferred.doneUnsafe(write, Effect.void))
          )
        );

        return;
      }

      if (written !== undefined) {
        yield* Deferred.succeed(written, undefined);
      }
    }
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));

  // A wait the follow's end cuts short: undefined once that has come.
  const untilEnded = <A, X>(waiting: Effect.Effect<A, never, X>) =>
    Effect.raceFirst(waiting, ended.pipe(Effect.as(undefined)));
  // One read of the config, none once a stop has come: checked in the step that starts its I/O, so no read begins
  // after a stop, where a read stalled on a mount would keep the process alive past the drain.
  const readUnlessStopping = Effect.suspend(() => (stopping() ? Effect.undefined : readConfigSnapshot(path)));
  // Each turn after the first, its wait and its read raced against the follow's end as one.
  const nextRead = untilEnded(
    Effect.sleep(mode._tag === "poll" ? mode.intervalMs : CONFIG_READ_MS).pipe(
      Effect.andThen(readUnlessStopping)
    )
  );
  const reader = Effect.gen(function* () {
    let last = first ?? (yield* untilEnded(readUnlessStopping));

    if (last !== undefined) {
      yield* Deferred.succeed(firstRead, last);
    }

    while (last !== undefined) {
      const next = yield* nextRead;

      if (next !== undefined && next.text !== last.text && !stopping()) {
        // In one step, waiting for neither: the newest config for the loop, and its announcement for the writer.
        Queue.offerUnsafe(mailbox, next);
        Queue.offerUnsafe(writes, [{ _tag: "Result", result: { _tag: "ConfigChanged" } }, undefined]);
      }

      last = stopping() ? undefined : next;
    }
  });

  // Starts a watch in a scope of its own, the host's stop and the follow's end forwarded into its halt.
  const begin = Effect.fnUntraced(function* (config: ProjectConfig) {
    const scope = yield* Scope.fork(generations, "sequential");
    const generation: Generation = { scope, halt: yield* Deferred.make<void>(), claimed: undefined };
    yield* Effect.raceFirst(
      Deferred.await(stop).pipe(Effect.as("host" as const)),
      ended.pipe(Effect.as("follow" as const))
    ).pipe(
      Effect.flatMap((by) => claim(generation, by)),
      Effect.forkIn(scope, { startImmediately: true })
    );
    const started = yield* Effect.exit(
      watchCatalogs(config, mode, generation.halt, generationOutput).pipe(Scope.provide(scope))
    );

    return { generation, started };
  });
  // Halts a watch, unless it has halted, and closes its scope, ending as its stop ended (a start that failed, with that).
  const retire = Effect.fnUntraced(function* (generation: Generation, started: Exit.Exit<Watching>) {
    yield* claim(generation, "follow");
    const end = Exit.isSuccess(started)
      ? yield* Effect.exit(started.value.done)
      : Exit.failCause(started.cause);
    yield* Scope.close(generation.scope, Exit.void);

    return end;
  });
  // How the loop left: how it ended, and whether the host's stop stopped it, no watch in hand halted on its own first.
  const leave = (generation: Generation | undefined, end: Exit.Exit<void>) => ({
    byHost: Deferred.isDoneUnsafe(stop) && (generation === undefined || !haltedOnOwn(generation)),
    end,
  });
  // At an iteration's first written result, the start unsettled: leave when a stop has come; otherwise the start
  // settles as ready, unless a newer config waits. One synchronous decision.
  const leavesUnsettled = () => {
    if (!Deferred.isDoneUnsafe(ready) && !stopping() && Queue.sizeUnsafe(mailbox) === 0) {
      Deferred.doneUnsafe(ready, Effect.void);
    }

    return !Deferred.isDoneUnsafe(ready) && stopping();
  };
  const loop = Effect.gen(function* () {
    let snapshot = yield* untilEnded(Deferred.await(firstRead));

    while (snapshot !== undefined) {
      const { loaded } = snapshot;
      let generation: Generation | undefined;

      if (loaded._tag === "ConfigInvalid") {
        yield* queued(failed(loaded.problem));

        if (leavesUnsettled()) {
          return leave(undefined, Exit.void);
        }

        yield* Effect.raceFirst(edited, ended);
      } else {
        const begun = yield* begin(loaded.config);
        const { started } = begun;
        ({ generation } = begun);

        // A stop halted the start (the host's, or the follow's end): it ends the follow, as the start's watch ended.
        if (generation.claimed !== undefined) {
          return leave(generation, yield* retire(generation, started));
        }

        if (Exit.isSuccess(started)) {
          yield* started.value.reported;

          if (leavesUnsettled()) {
            return leave(generation, yield* retire(generation, started));
          }

          yield* Effect.raceAll([edited, ended, Deferred.await(generation.halt)]);
          const end = yield* retire(generation, started);

          if (Exit.isFailure(end) || haltedOnOwn(generation)) {
            return leave(generation, end);
          }
        } else {
          const end = yield* retire(generation, started);

          if (Deferred.isDoneUnsafe(ready)) {
            yield* queued(failed(didNotStart(path, started.cause)));
            yield* Effect.raceFirst(edited, ended);
          } else if (stopping() || Queue.sizeUnsafe(mailbox) === 0) {
            return leave(generation, end);
          }
        }
      }

      if (stopping()) {
        return leave(generation, Exit.void);
      }

      snapshot = yield* Queue.take(mailbox);
    }

    return leave(undefined, Exit.void);
  });
  // The follow: the loop leaves, the reader stops, every write queued is written, and it ends with the writer's
  // failure, then a defect, then as the loop left.
  const following = Effect.fnUntraced(
    function* (writing: Fiber.Fiber<void>) {
      yield* Deferred.await(stop).pipe(Effect.andThen(Deferred.succeed(ending, undefined)), Effect.forkChild);
      const reading = yield* supervised(reader).pipe(Effect.forkChild);
      const left = yield* Effect.exit(supervised(loop));
      yield* Deferred.succeed(ending, undefined);
      yield* Fiber.interrupt(reading);
      yield* Scope.close(generations, Exit.void);
      yield* Queue.end(writes);
      yield* Fiber.join(writing);
      const fatal = writeFailure ?? defect;
      stoppedByHost = fatal === undefined && Exit.isSuccess(left) && left.value.byHost;

      return yield* fatal === undefined
        ? Exit.isSuccess(left)
          ? left.value.end
          : Exit.failCause(left.cause)
        : Effect.failCause(fatal);
    },
    Deferred.into(finished),
    Effect.uninterruptible
  );
  // Registered before the reader or any watch starts, so the caller's scope closing at any moment ends the follow.
  yield* Effect.acquireRelease(
    Effect.forkDetach(writeInOrder).pipe(Effect.flatMap((writing) => Effect.forkDetach(following(writing)))),
    () => Deferred.succeed(ending, undefined).pipe(Effect.andThen(outcome.unclaimed))
  ).pipe(Scope.provide(own));
  // Ready, or the follow's end, which the start claims in this step, so a scope's close leaves it to the start until
  // the start has settled: unless the host stopped it, the start takes that end, failing with it or, a clean end (the
  // caller's scope closed), stopped. An interrupted start, or a ready one, takes nothing, and the scope's close
  // reports it unless `done` takes it.
  const start = yield* outcome.claiming(
    () => stoppedByHost,
    (end) =>
      Effect.raceFirst(
        Deferred.await(ready).pipe(Effect.as("Ready" as const)),
        end.pipe(Effect.as("Stopped" as const))
      )
  );

  return { _tag: start, done: outcome.done } satisfies Following;
});

// A restart's watch that failed to start, as the problem the follow writes.
function didNotStart(path: string, cause: Cause.Cause<never>): Problem {
  const failure = Cause.squash(cause);

  return {
    code: "WatchFailed",
    message: `the watch on the edited ${basename(path)} did not start: ${failure instanceof Error ? failure.message : String(failure)}`,
    fix: `fix what the error names, then edit ${basename(path)} or restart the watch`,
  };
}
