// `extract --watch`: one debounced, add-only sync per burst of source or catalog changes. Add-only so a file saved
// mid-edit or a branch switch never drops a translation; explicit `extract` removes unused entries.
//
// The watch runs as ordered stages in scopes it owns (see `watchCatalogs`): the trees' deliveries admitted through a
// stop gate, classification, debounce, one sync at a time, and one fiber that writes every result in order. Which trees,
// and how their changes are delivered, is `watch-trees.ts`.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { readFileSync } from "node:fs";
import { sep } from "node:path";

import type { ExtractOptions, ExtractResult } from "./commands";
import { extractCatalogs } from "./commands";
import type { Problem } from "./problem";
import type { ParseCache } from "./project";
import { isExcludedDirectory, isProjectSource } from "./project";
import { catalogPath } from "./project-catalogs";
import type { ProjectConfig } from "./project-config";
import type { Change, FileEvents, Intake } from "./watch-trees";
import { includePrefixes, listenNative, movesTree, startPolling, watchRoots } from "./watch-trees";

/** What one sync did. */
export type SyncResult =
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Unchanged" }
  /** A catalog was saved during the sync, so it wrote nothing; another sync follows. */
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> };

/**
 * A sync that threw, I/O the extractor does not classify or a report that could not be written, as the result the
 * watch reports in its place.
 *
 * @param message - What the sync threw, as its message.
 * @returns A failed result with one `SyncFailed` problem naming the error.
 */
export function syncFailed(message: string): SyncResult {
  return {
    _tag: "Failed",
    problems: [
      {
        code: "SyncFailed",
        message,
        fix: "fix the file the error names; the next change retries",
      },
    ],
  };
}

/** A watch a host has started: its start, and its stop, which the host may ask for at any time, the start included. */
export type ProjectWatcher = {
  /**
   * Settles once the first sync's result is reported, or, cleanly, once a stop the host asked for during the start
   * has run (how that stop ended is the close's to report). Otherwise rejects with the watch's start failure, the first
   * result's report failure, or an Error saying the runtime was disposed during the start, after the watch has stopped
   * and closed every watcher it started.
   */
  readonly started: Promise<void>;
  /**
   * Stop watching, at once: no change is accepted, the watchers close (a tree still opening opens nothing more), a
   * pending sync is dropped, a running one finishes, and every result made is reported. Settles when the watch has
   * ended, every watcher it opened closed; the same shutdown for every call. Rejects, on the first call only, with a
   * report's failure or a failed close that ended the watch, the start's included when this close stopped it; a start
   * that failed before any close is the start's to report.
   */
  readonly close: () => Promise<void>;
};

/**
 * Where change events come from. `native` is the platform's file events (`fs.watch`, recursive); `poll` stats every
 * watched file each `intervalMs`, for hosts whose native events arrive late or not at all (a container's bind mount,
 * a network drive, a macOS whose fseventsd is saturated): slower to notice and costlier, but it depends on no event
 * daemon.
 */
export type WatchMode = { readonly _tag: "native" } | { readonly _tag: "poll"; readonly intervalMs: number };

const NATIVE: WatchMode = { _tag: "native" };

/** The shortest poll interval: below it, a walk per tick of a real project is a continuous scan. */
export const MIN_POLL_MS = 10;
/** The longest delay Node's timers keep; a longer one becomes 1 ms. */
export const MAX_POLL_MS = 2_147_483_647;

/** A poll interval out of the range the poller takes. */
export type PollIntervalOutOfRange = { readonly _tag: "PollIntervalOutOfRange"; readonly intervalMs: number };

/**
 * Parse a poll interval into a polling watch mode.
 *
 * @param intervalMs - Milliseconds between walks.
 * @returns The polling mode, or `PollIntervalOutOfRange` for anything but a whole number from 10 to 2147483647.
 */
export function pollEvery(intervalMs: number): WatchMode | PollIntervalOutOfRange {
  return Number.isInteger(intervalMs) && intervalMs >= MIN_POLL_MS && intervalMs <= MAX_POLL_MS
    ? { _tag: "poll", intervalMs }
    : { _tag: "PollIntervalOutOfRange", intervalMs };
}

// Long enough to fold a branch switch or a formatter's multi-file save into one sync.
const DEBOUNCE_MS = 100;

/** A sync's extract threw: I/O the extractor does not classify, such as a file a checkout deletes mid-scan. */
export class SyncFailed
  extends /* @__PURE__ */ Schema.TaggedError<SyncFailed>()("SyncFailed", {
    /** The thrown error's message. */
    message: Schema.String,
  }) {}

/**
 * One sync's extract: what the watch runs per burst of changes. A service so the commands can become effects behind
 * it, and so a test can act between a sync's read and its writes.
 */
export class CatalogSync
  extends /* @__PURE__ */ Context.Service<
    CatalogSync,
    {
      /** Extract the project's messages into its catalogs, as `extractCatalogs` does. */
      readonly extract: (
        config: ProjectConfig,
        options: ExtractOptions
      ) => Effect.Effect<ExtractResult, SyncFailed>;
    }
  >()("elmera-intl-tools/CatalogSync")
{
  /**
   * The synchronous `extractCatalogs`.
   *
   * @returns A layer whose extract runs `extractCatalogs`, its throw a `SyncFailed`.
   */
  static layer(): Layer.Layer<CatalogSync> {
    return Layer.succeed(CatalogSync, {
      extract: Effect.fn("CatalogSync.extract")(function* (config: ProjectConfig, options: ExtractOptions) {
        return yield* Effect.try({
          try: () => extractCatalogs(config, options),
          catch: (error) =>
            new SyncFailed({ message: error instanceof Error ? error.message : String(error) }),
        });
      }),
    });
  }
}

/** Where a watch writes, each write in order, from one fiber. */
export type WatchOutput<R> = {
  /**
   * Writes one result: a sync's, or a problem that leaves part of the project unwatched. A write that fails is
   * written again as that sync's `SyncFailed`; when that fails too, the watch ends with the failure.
   */
  readonly report: (result: SyncResult) => Effect.Effect<void, never, R>;
  /** Writes that the watch has started, after the first sync's result. A failure ends the watch. */
  readonly ready: Effect.Effect<void, never, R>;
};

/** A started watch. */
export type Watching = {
  /**
   * Waits for the watch to stop (the stop signal, a write that fails for good, a defect, or its scope closing), then
   * ends as the stop ended (see `watchCatalogs`): dying with the failure of a write that failed for good, a worker's
   * defect, or a watcher that failed to close.
   */
  readonly done: Effect.Effect<void>;
  /**
   * Waits until the first sync's result and the ready line are written; dies with the failure of a write that failed
   * for good before then. For a host that starts the watch on its own call and must fail that call.
   */
  readonly reported: Effect.Effect<void>;
};

// What the reporting fiber writes, in order: a result (a sync's, or a problem that leaves part of the project
// unwatched), or the ready line.
type Output = { readonly _tag: "Result"; readonly result: SyncResult } | { readonly _tag: "Ready" };

const failed = (problem: Problem): Output => ({
  _tag: "Result",
  result: { _tag: "Failed", problems: [problem] },
});

function syncResult(result: ExtractResult): SyncResult {
  return result.problems.length > 0
    ? { _tag: "Failed", problems: result.problems }
    : result.superseded
      ? { _tag: "Superseded" }
      : result.written.length > 0
        ? { _tag: "Written", files: result.written.map(({ path }) => path) }
        : { _tag: "Unchanged" };
}

// What every stage of one watch shares.
type Pipeline = {
  readonly config: ProjectConfig;
  readonly catalogs: ReadonlySet<string>;
  readonly includeRoots: ReadonlyArray<string>;
  // Outlives each sync: an unchanged file is not parsed again.
  readonly cache: ParseCache;
  // The text this watch last wrote to each catalog: a change that finds it unchanged is our own write.
  readonly written: Ref.Ref<ReadonlyMap<string, string>>;
  // Each admitted change, for classification.
  readonly intake: Queue.Queue<Change>;
  // Every output, in order, for the writer.
  readonly results: Queue.Queue<Output, Cause.Done>;
  // That a change can alter a catalog, for the debounce: coalesced, since one pending trigger restarts it as well as
  // many.
  readonly triggers: Queue.Queue<void>;
  // Held by a sync from its read until it has recorded its writes, and by each classification.
  readonly syncing: Semaphore.Semaphore;
  // Done once the watch must stop: a write that fails for good, a defect, its scope closing, or the stop itself. With
  // the caller's stop signal, the stop gate.
  readonly halt: Deferred.Deferred<void>;
  // The caller's stop signal, which the watch claims itself (completes first) the moment it halts on its own: whoever
  // completed it first started the stop.
  readonly stop: Deferred.Deferred<void>;
  // Done once every tree is watched (a poll's first walks taken): the first sync starts then.
  readonly sourcesOpened: Deferred.Deferred<void>;
  // Done once the first sync has run and its result and the ready line are queued: classification starts then.
  readonly firstSynced: Deferred.Deferred<void>;
  // Done once the ready line is written.
  readonly readyWritten: Deferred.Deferred<void>;
};

const makePipeline = /* @__PURE__ */ Effect.fnUntraced(function* (
  config: ProjectConfig,
  stop: Deferred.Deferred<void>
) {
  return {
    config,
    stop,
    catalogs: new Set(config.locales.map((locale) => catalogPath(config, locale))),
    includeRoots: includePrefixes(config),
    cache: new Map(),
    written: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
    intake: yield* Queue.unbounded<Change>(),
    results: yield* Queue.unbounded<Output, Cause.Done>(),
    triggers: yield* Queue.dropping<void>(1),
    syncing: yield* Semaphore.make(1),
    halt: yield* Deferred.make<void>(),
    sourcesOpened: yield* Deferred.make<void>(),
    firstSynced: yield* Deferred.make<void>(),
    readyWritten: yield* Deferred.make<void>(),
  } satisfies Pipeline;
});

// The one writer: every output in order, each failed result written again as SyncFailed. A write that fails for good
// halts the watch and ends the writer with its failure.
function writer<R>(pipeline: Pipeline, output: WatchOutput<R>) {
  const write = (next: Output) =>
    next._tag === "Ready"
      ? output.ready
      : output
          .report(next.result)
          .pipe(
            Effect.catchDefect((defect) =>
              output.report(syncFailed(defect instanceof Error ? defect.message : String(defect)))
            )
          );

  return Effect.gen(function* () {
    for (;;) {
      const next = yield* Queue.take(pipeline.results);
      yield* write(next).pipe(Effect.onError(() => haltOnOwn(pipeline)));

      if (next._tag === "Ready") {
        yield* Deferred.succeed(pipeline.readyWritten, undefined);
      }
    }
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
}

// One sync. Its read, its writes and their record happen under the permit, so no change is classified against a
// record that is about to change; a trigger queued before the permit was taken is for a change this sync reads. A
// running sync is never cut short: stopping waits for it, and its result is still written.
function syncStep(pipeline: Pipeline, catalogSync: CatalogSync["Service"]) {
  return Effect.gen(function* () {
    yield* Queue.clear(pipeline.triggers);
    const result = yield* catalogSync.extract(pipeline.config, {
      unused: "keep",
      cache: pipeline.cache,
      concurrentSave: "yield",
    });
    yield* Ref.update(
      pipeline.written,
      (before) => new Map([...before, ...result.written.map(({ path, text }) => [path, text] as const)])
    );

    // Not left to the save's own change: a save back to text this watch wrote reads as our own write, and the change
    // that started this sync would be lost.
    if (result.superseded) {
      yield* Queue.offer(pipeline.triggers, undefined);
    }

    return syncResult(result);
  }).pipe(
    Effect.catchTag("SyncFailed", (failure) => Effect.succeed(syncFailed(failure.message))),
    Semaphore.withPermit(pipeline.syncing),
    Effect.flatMap((result) => Queue.offer(pipeline.results, { _tag: "Result", result })),
    Effect.uninterruptible
  );
}

// Whether a change can alter a catalog, against `written` as it stood when its batch was taken: a catalog whose text
// is not what this watch last wrote, a project source, or a rename that moved a tree under an include root.
function alters(pipeline: Pipeline, written: ReadonlyMap<string, string>, change: Change): boolean {
  if (change.path === null) {
    return true;
  }

  if (pipeline.catalogs.has(change.path)) {
    const ours = written.get(change.path);

    if (ours === undefined || readText(change.path) !== ours) {
      return true;
    }
  } else if (isProjectSource(pipeline.config, change.path)) {
    return true;
  }

  return change.event === "rename" && movesTree(pipeline.includeRoots, change.path);
}

// Classification, from the first sync on: every change admitted since the last one, under one permit (so never while a
// sync runs, and a catalog's change is compared with what the last sync wrote), queues one trigger when any can alter a
// catalog. A burst is one classification and one trigger.
const classifier = /* @__PURE__ */ Effect.fnUntraced(function* (pipeline: Pipeline) {
  yield* Deferred.await(pipeline.firstSynced);

  for (;;) {
    const changes = yield* Queue.takeAll(pipeline.intake);
    const fires = yield* Ref.get(pipeline.written).pipe(
      Effect.map((written) => changes.some((change) => alters(pipeline, written, change))),
      Semaphore.withPermit(pipeline.syncing)
    );

    if (fires) {
      yield* Queue.offer(pipeline.triggers, undefined);
    }
  }
});

// The debounce: after a trigger, one sync once no trigger has come for DEBOUNCE_MS. Each wait is a relative sleep (the
// live clock's setTimeout, not a wall-clock deadline), so a wall-clock correction neither delays nor hastens a sync.
function debouncer(pipeline: Pipeline, sync: Effect.Effect<void>) {
  const quiet = Queue.take(pipeline.triggers).pipe(
    Effect.as(false),
    Effect.timeoutOrElse({ duration: DEBOUNCE_MS, orElse: () => Effect.succeed(true) })
  );

  return Effect.gen(function* () {
    for (;;) {
      yield* Queue.take(pipeline.triggers);
      let settled = false;

      while (!settled) {
        settled = yield* quiet;
      }

      yield* sync;
    }
  });
}

// The watch's own scope, and the two children its stop closes.
// The watch halts on its own (a write that fails for good, a defect, its scope closing): it claims the stop signal
// first, synchronously, so a stop asked for from then on never counts as the one that stopped it.
const haltOnOwn = (pipeline: Pipeline) =>
  Deferred.succeed(pipeline.stop, undefined).pipe(Effect.andThen(Deferred.succeed(pipeline.halt, undefined)));

type Scopes = {
  readonly own: Scope.Scope;
  readonly sources: Scope.Closeable;
  readonly workers: Scope.Closeable;
};

// The watch's one stop, and the outcome everyone who waits for it shares. One fiber runs it, uninterruptibly, once the
// stop signal or a halt comes: it shuts the gate (`halt`); closes `sources`, so the watchers close at once; closes
// `workers`, which drops a pending sync and waits for a running one; ends the results; and joins the writer, so every
// result already made is written. It ends as the writing ended, then as a worker's defect, then as the watchers closed,
// and settles `finished` with that.
//
// The writer and that stopper are acquired together on `own`, each forked detached, so neither depends on `own` being
// open: an acquire is uninterruptible and its release always runs, at once when `own` is closed already (a caller
// scope closed before the watch, or during its setup), else first as `own` closes, whatever the caller's strategy. The
// release halts the watch, waits for the stopper, and fails with the stop's outcome unless `done` handed it to someone,
// so an interrupted caller never hides a defect.
const ownedStop = /* @__PURE__ */ Effect.fnUntraced(function* <R>(
  pipeline: Pipeline,
  scopes: Scopes,
  writes: Effect.Effect<void, never, R>,
  stop: Deferred.Deferred<void>
) {
  const { halt } = pipeline;
  // A worker's defect: it halts the watch, and the stop ends with it.
  let defect: Cause.Cause<never> | undefined;
  // Whether the stop's outcome reached someone (`done`'s caller, or a start that failed with it).
  let delivered = false;
  const finished = yield* Deferred.make<void>();
  const shutdown = Effect.fnUntraced(
    function* (writing: Fiber.Fiber<void>) {
      yield* Deferred.succeed(halt, undefined);
      const closed = yield* Effect.exit(Scope.close(scopes.sources, Exit.void));
      yield* Scope.close(scopes.workers, Exit.void);
      yield* Queue.end(pipeline.results);
      yield* Fiber.join(writing);

      if (defect !== undefined) {
        return yield* Effect.failCause(defect);
      }

      return yield* closed;
    },
    Deferred.into(finished),
    Effect.uninterruptible
  );
  const fibers = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const writing = yield* Effect.forkDetach(writes);
      const stopping = yield* Effect.raceFirst(Deferred.await(stop), Deferred.await(halt)).pipe(
        Effect.andThen(shutdown(writing)),
        Effect.forkDetach
      );

      return { writing, stopping };
    }),
    ({ stopping }) =>
      haltOnOwn(pipeline).pipe(
        Effect.andThen(Fiber.await(stopping)),
        Effect.andThen(Effect.exit(Deferred.await(finished))),
        Effect.flatMap((exit) => (delivered ? Effect.void : exit))
      )
  ).pipe(Scope.provide(scopes.own));

  return {
    // The writer, for a host that waits for its first writes.
    writing: fibers.writing,
    // Waits for the stop, then hands its outcome to the caller, who then owns reporting it.
    done: Effect.exit(Deferred.await(finished)).pipe(
      Effect.flatMap((exit) =>
        Effect.suspend(() => {
          delivered = true;

          return exit;
        }).pipe(Effect.uninterruptible)
      )
    ),
    // A worker whose defect halts the watch, the stop then ending with it.
    supervised: <A>(worker: Effect.Effect<void, never, A>) =>
      worker.pipe(
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.suspend(() => {
                defect ??= cause;

                return haltOnOwn(pipeline);
              })
        )
      ),
  };
});

/**
 * Sync the catalogs now, then after every change to a source file the config includes or to a catalog. Syncs add
 * messages and references and never remove an entry or a translation; a sync that finds a problem writes nothing.
 * The catalogs it writes do not trigger another sync.
 *
 * The watch owns a scope inside the caller's, with two children: `sources`, which opens the trees and holds their
 * native listeners or poll walks, and `workers`, the first sync, classification and the debounce. Each delivery is
 * admitted through the stop gate as it happens: its warnings to the writer, its changes to classification, which (never
 * while a sync runs) queues a trigger for the debounce; then one sync runs, and its result joins the outputs, which one
 * fiber writes in order. Syncs never overlap, and no sync waits for a write.
 *
 * Returns once the trees are watched (a poll's first walks taken, the next ones already timed from them) and the first
 * sync has run, so no change after it returns is missed. A stop during the start (or before it) ends the start once the
 * stop has run, with no first sync unless that had begun, and with the stop's outcome when that is a failure.
 *
 * One stop, whatever asks first (the stop signal, a write that fails for good, a defect, a tree that fails to open, or
 * the caller's scope closing): the gate shuts, so nothing delivered after it is admitted; `sources` closes, so the
 * watchers close at once (a tree still opening first, so a watcher it is acquiring is closed too); `workers` closes,
 * dropping a pending sync and waiting for a running one; then every result already made is written. It ends as the
 * writing ended, then as the workers ended, then as the watchers closed. `done` delivers that outcome; when nothing
 * does (an interrupted `done`, or no `done`), the scope's close fails with it, so no defect is lost.
 *
 * @param config - The project config.
 * @param mode - Where change events come from.
 * @param stop - Done when the watch should stop; from then on no change is accepted. The watch completes it itself the
 *   moment it halts on its own, before any cleanup, so a caller that completes it (`Deferred.doneUnsafe` returning
 *   true) knows its stop is the one that stopped the watch.
 * @param output - Where the results and the ready line are written.
 * @returns An effect that starts the watch in its scope.
 */
export const watchCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.watch.start")(function* <R>(
  config: ProjectConfig,
  mode: WatchMode,
  stop: Deferred.Deferred<void>,
  output: WatchOutput<R>
) {
  const catalogSync = yield* CatalogSync;
  const pipeline = yield* makePipeline(config, stop);
  const { halt, results } = pipeline;
  // The watch's own scope: closed in order whatever the caller's strategy, its stop first.
  const own = yield* Scope.fork(yield* Effect.scope, "sequential");
  const sources = yield* Scope.fork(own, "sequential");
  // `sources` closes `opening` before `watchers` (the last child first), so a watcher a tree is still acquiring as the
  // stop lands is held by `watchers` when that closes it.
  const watchers = yield* Scope.fork(sources, "sequential");
  const opening = yield* Scope.fork(sources, "sequential");
  const workers = yield* Scope.fork(own, "sequential");
  const owned = yield* ownedStop(pipeline, { own, sources, workers }, writer(pipeline, output), stop);
  const isHalted = () => Deferred.isDoneUnsafe(stop) || Deferred.isDoneUnsafe(halt);

  // The stop gate, at delivery: each warning and change is admitted at once, synchronously, as the tree delivers it
  // (its warnings to the writer, its changes to classification), or from the stop on not at all. What was admitted
  // before the stop is the stop's to drain.
  const admit = (item: Intake): void => {
    if (isHalted()) {
      return;
    }

    if (item.problems.length > 0) {
      Queue.offerAllUnsafe(
        results,
        item.problems.map((problem) => failed(problem))
      );
    }

    if (item.changes.length > 0) {
      Queue.offerAllUnsafe(pipeline.intake, item.changes);
    }
  };
  // A directory the config excludes holds no source; one holding a catalog is still walked.
  const prune = (directory: string): boolean =>
    isExcludedDirectory(config, directory) &&
    ![...pipeline.catalogs].some((catalog) => catalog.startsWith(`${directory}${sep}`));
  const roots = watchRoots(pipeline.includeRoots, [...pipeline.catalogs]);
  // The trees open in `opening`, their watchers held by `watchers`; none once the stop has begun. A tree that fails to
  // open stops the watch, like any worker's defect.
  const open = Effect.suspend(() =>
    isHalted()
      ? Effect.void
      : (mode._tag === "poll"
          ? startPolling(roots, mode.intervalMs, prune, admit, owned.supervised)
          : listenNative(roots, admit)
        ).pipe(Scope.provide(watchers), Effect.andThen(Deferred.succeed(pipeline.sourcesOpened, undefined)))
  );
  yield* owned.supervised(open).pipe(Effect.forkIn(opening));
  const sync = syncStep(pipeline, catalogSync);
  // Once the trees are watched: the first sync, then its result and the ready line, in one step the stop waits for;
  // none once the stop has begun.
  const firstSync = Deferred.await(pipeline.sourcesOpened).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        isHalted()
          ? Effect.void
          : sync.pipe(
              Effect.andThen(Queue.offer(results, { _tag: "Ready" })),
              // Not once the watch has halted meanwhile: the start then waits for the stop, and ends as it did.
              Effect.andThen(
                Effect.suspend(() =>
                  isHalted() ? Effect.void : Deferred.succeed(pipeline.firstSynced, undefined)
                )
              )
            )
      ).pipe(Effect.uninterruptible)
    )
  );
  // Every worker forks into `workers`; once the stop has closed it, none starts.
  for (const worker of [firstSync, classifier(pipeline), debouncer(pipeline, sync)]) {
    yield* owned.supervised(worker).pipe(Effect.forkIn(workers));
  }
  // Until the first sync is queued, or the stop has run: then the start ends as the stop did.
  yield* Effect.raceFirst(Deferred.await(pipeline.firstSynced), owned.done);

  return {
    done: owned.done,
    reported: Effect.raceFirst(Deferred.await(pipeline.readyWritten), Fiber.join(owned.writing)),
  } satisfies Watching;
});

/** The services a host's runtime provides a watch: the sync's extract and the file events. */
export type WatchServices = CatalogSync | FileEvents;

/**
 * Start a watch outside an Effect program, on a runtime the host owns: `watchCatalogs` in a scope of its own, on one
 * fiber of `runtime`, which provides the sync's extract and the file events. The stop handle is the host's at once, so
 * a host that closes during the start stops it there; the runtime's disposal is the backstop, which interrupts that
 * fiber and so closes the watch's scope, a start still pending included.
 *
 * @param runtime - The host's runtime.
 * @param config - The project config.
 * @param report - Called with each result, in order; one that throws is called again with that sync's `SyncFailed`.
 *   When that throws too, the watch ends: on the first sync's result, by rejecting the start; later, by throwing the
 *   error on the host's event loop.
 * @param mode - Where change events come from; native file events unless the caller polls.
 * @returns The watch: its start, and its stop.
 */
export function watchProject(
  runtime: ManagedRuntime.ManagedRuntime<WatchServices, never>,
  config: ProjectConfig,
  report: (result: SyncResult) => void,
  mode: WatchMode = NATIVE
): ProjectWatcher {
  const stop = Deferred.makeUnsafe<void>();
  const firstReported = Promise.withResolvers<"started">();
  // The watch for its whole life, in a scope that closes as its fiber ends, after the start fails or the watch stops:
  // the scope's stop has then closed every watcher.
  const ended = runtime.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const watching = yield* watchCatalogs(config, mode, stop, {
          report: (result) =>
            Effect.sync(() => {
              report(result);
            }),
          ready: Effect.void,
        });
        yield* watching.reported;
        yield* Effect.sync(() => {
          firstReported.resolve("started");
        });
        yield* watching.done;
      })
    )
  );
  // Whether the host has asked the watch to stop, and whether that request is what stopped it: decided as the request
  // claims the stop signal, which the watch claims itself the moment it halts on its own, before any cleanup.
  let closing = false;
  let stoppedByHost = false;
  // Whether the watch's end is someone else's to report: the host's first close, or the event loop's, once a failure
  // that ended the watch was thrown there.
  let endReported = false;
  const started = Promise.race([firstReported.promise, ended]).then((start) => {
    if (start === "started") {
      void ended.then((exit) => {
        const cause = endFailure(exit);

        // Unless the host is stopping it, nothing is left to report a failure that ends the watch: it ends the host, as
        // a throwing report always did.
        if (!closing && !endReported && cause !== undefined) {
          endReported = true;
          queueMicrotask(() => {
            throw Cause.squash(cause);
          });
        }
      });

      return;
    }

    // A stop the host asked for during the start, before the watch halted on its own, ends the start cleanly, and the
    // end (a watcher's failure to close, say) is the first close's to report.
    if (stoppedByHost) {
      return;
    }

    // Otherwise the start's own failure is the start's to report, never a close's, whenever a close comes.
    endReported = true;
    const failure = endFailure(start);

    if (failure !== undefined) {
      throw Cause.squash(failure);
    }

    // An end by interruption alone, unasked, is the host's own disposal; Effect's squash of it names no cause.
    throw new Error(
      Exit.isFailure(start)
        ? "the watch's runtime was disposed during its start"
        : "the watch ended before its first result was reported"
    );
  });
  // The one shutdown: the stop signalled, then the watch's end once the start has settled.
  let shutdown: Promise<void> | undefined;

  return {
    started,
    close: () => {
      if (shutdown !== undefined) {
        return shutdown.catch(() => undefined);
      }

      closing = true;
      stoppedByHost = Deferred.doneUnsafe(stop, Effect.void);
      shutdown = started
        .then(
          () => ended,
          () => undefined
        )
        .then((exit) => {
          const cause = exit === undefined ? undefined : endFailure(exit);

          if (!endReported && cause !== undefined) {
            endReported = true;
            throw Cause.squash(cause);
          }

          endReported = true;
        });

      return shutdown;
    },
  };
}

// How a watch's fiber ended, when that is a failure to report: an end by interruption alone (its runtime disposed) has
// nothing to report.
function endFailure(exit: Exit.Exit<void>): Cause.Cause<never> | undefined {
  return Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? exit.cause : undefined;
}

// A catalog deleted or replaced by a directory reads as changed.
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
