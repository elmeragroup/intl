// `extract --watch`: one debounced, add-only sync per burst of source or catalog changes. Add-only so a file saved
// mid-edit or a branch switch never drops a translation; explicit `extract` removes unused entries.
//
// The watch runs as ordered stages in a scope (see `watchCatalogs`): the trees' changes as one scoped Stream, a stop
// gate, classification, debounce, one sync at a time, and one fiber that writes every result in order.
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { BigIntStats } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { ExtractOptions, ExtractResult } from "./commands";
import { extractCatalogs } from "./commands";
import type { Problem } from "./problem";
import type { ParseCache } from "./project";
import { catalogPath, isExcludedDirectory, isProjectSource } from "./project";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE } from "./project-config";

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

/** A running watch. */
export type ProjectWatcher = {
  /**
   * Stop watching: the watchers close and no change is accepted, a pending sync is dropped, a running one finishes,
   * and every result made is reported. Rejects with a report's failure that ended the watch, or a failed close.
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
const GLOB_CHARS = /[*?[{]/u;
const NODE_MODULES = "**/node_modules/**";

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

/** The kind of a file event: a path that appeared or went away, or a file whose content changed. */
export type ChangeEvent = "rename" | "change";

/** Where one tree's file events go. */
export type TreeListener = {
  /** A path under the tree changed; `filename` is relative to the tree, or null when the platform could not say. */
  readonly change: (event: ChangeEvent, filename: string | null) => void;
  /** The tree is no longer watched. */
  readonly error: (error: Error) => void;
};

/**
 * The platform's recursive file events for one tree: what a native watch listens to. A service so a host can feed
 * its own watcher's events, and so a test can deliver an event, or an error, at a moment it chooses.
 */
export class FileEvents
  extends /* @__PURE__ */ Context.Service<
    FileEvents,
    {
      /**
       * Listen to `dir`'s tree, from when this returns until the scope closes. A listener's calls are synchronous,
       * from the event loop.
       */
      readonly watch: (dir: string, listener: TreeListener) => Effect.Effect<void, never, Scope.Scope>;
    }
  >()("elmera-intl-tools/FileEvents")
{
  /**
   * Node's recursive `fs.watch`, node_modules ignored.
   *
   * @returns A layer whose watch opens an `fs.watch` in the scope (its start failure a defect) and closes it as the
   *   scope closes.
   */
  static layer(): Layer.Layer<FileEvents> {
    return Layer.succeed(FileEvents, {
      watch: Effect.fn("FileEvents.watch")(function* (dir: string, listener: TreeListener) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(dir, { recursive: true, ignore: NODE_MODULES }, listener.change).on("error", listener.error)
          ),
          (watcher) =>
            Effect.sync(() => {
              watcher.close();
            })
        );
      }),
    });
  }
}

// A change seen in a watched tree; no path when the platform could not say what changed, so anything may have.
type Change = { readonly event: ChangeEvent; readonly path: string | null };

// What the reporting fiber writes, in order: a result (a sync's, or a problem that leaves part of the project
// unwatched), or the ready line.
type Output = { readonly _tag: "Result"; readonly result: SyncResult } | { readonly _tag: "Ready" };

// What the trees deliver, per poll walk or per native event: the problems that leave part of the project unwatched,
// and the changes. Each is admitted at delivery, whole, or from the stop on not at all.
type Intake = { readonly problems: ReadonlyArray<Problem>; readonly changes: ReadonlyArray<Change> };

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
   * Waits for the stop signal, or for a write that fails for good, then stops the watch (see `watchCatalogs`) and ends
   * as the writing ended: dying with the failure of a write that failed for good, or of a watcher that failed to close.
   */
  readonly done: Effect.Effect<void>;
  /**
   * Waits until the first sync's result and the ready line are written; dies with the failure of a write that failed
   * for good before then. For a host that starts the watch on its own call and must fail that call.
   */
  readonly reported: Effect.Effect<void>;
};

/**
 * Sync the catalogs now, then after every change to a source file the config includes or to a catalog. Syncs add
 * messages and references and never remove an entry or a translation; a sync that finds a problem writes nothing.
 * The catalogs it writes do not trigger another sync.
 *
 * The watch runs in stages, each a fiber in the caller's scope. The trees' changes are one scoped Stream: native file
 * events, whose watchers it opens and closes, or a poll's walks, the first at once and then every `intervalMs`. Each
 * item passes the stop gate, and its changes are classified one batch at a time, never while a sync runs, so a
 * catalog's change is compared with what the last sync wrote; a change that can alter a catalog restarts the debounce,
 * a relative sleep; then one sync runs, and its result joins the outputs, which one fiber writes in order. Syncs never
 * overlap, and no sync waits for a write.
 *
 * Returns once the trees are watched (a poll's first walk taken, the next one already timed from it) and the first
 * sync has run, so no change after it returns is missed.
 *
 * The watch stops on `done` after the stop signal or a write that fails for good, or when the caller's scope closes,
 * in the same order: the source Stream is interrupted, which closes the watchers at once, and nothing it yields after
 * the stop is accepted; a pending sync is dropped and a running one finishes; then every result already made is
 * written.
 *
 * @param config - The project config.
 * @param mode - Where change events come from.
 * @param stop - Done when the watch should stop; from then on no change is accepted.
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
  const fileEvents = yield* FileEvents;
  // Outlives each sync: an unchanged file is not parsed again.
  const cache: ParseCache = new Map();
  const catalogs = new Set(config.locales.map((locale) => catalogPath(config, locale)));
  const includeRoots = includePrefixes(config);
  // The text this watch last wrote to each catalog: a change that finds it unchanged is our own write.
  const written = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const queues = {
    intake: yield* Queue.unbounded<ReadonlyArray<Change>>(),
    results: yield* Queue.unbounded<Output, Cause.Done>(),
  };
  // Each change that can alter a catalog, for the debounce.
  const triggers = yield* Queue.unbounded<void>();
  // Held by a sync from its read until it has recorded its writes, and by the classification of each batch.
  const syncing = yield* Semaphore.make(1);
  // Done when a write fails for good.
  const fatal = yield* Deferred.make<void>();
  // Set once the watch stops, whatever stopped it: from then on nothing is accepted.
  let stopping = false;
  const isHalted = () => stopping || Deferred.isDoneUnsafe(stop) || Deferred.isDoneUnsafe(fatal);
  // Done once the ready line is written.
  const readyWritten = yield* Deferred.make<void>();

  // The one writer: every output in order, each failed result written again as SyncFailed.
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
  const writing = yield* Queue.take(queues.results).pipe(
    Effect.flatMap((next) =>
      write(next).pipe(
        Effect.onError(() => Deferred.succeed(fatal, undefined)),
        Effect.andThen(next._tag === "Ready" ? Deferred.succeed(readyWritten, undefined) : Effect.void)
      )
    ),
    Effect.forever,
    Effect.catchIf(Cause.isDone, () => Effect.void),
    Effect.forkScoped
  );

  // One sync. Its read, its writes and their record happen under the permit, so no change is classified against a
  // record that is about to change; a trigger queued before the permit was taken is for a change this sync reads. A
  // running sync is never cut short: stopping waits for it, and its result is still written.
  const sync = Effect.gen(function* () {
    yield* Queue.clear(triggers);
    const result = yield* catalogSync.extract(config, { unused: "keep", cache, concurrentSave: "yield" });
    yield* Ref.update(
      written,
      (before) => new Map([...before, ...result.written.map(({ path, text }) => [path, text] as const)])
    );

    // Not left to the save's own change: a save back to text this watch wrote reads as our own write, and the change
    // that started this sync would be lost.
    if (result.superseded) {
      yield* Queue.offer(triggers, undefined);
    }

    return syncResult(result);
  }).pipe(
    Effect.catchTag("SyncFailed", (failure) => Effect.succeed(syncFailed(failure.message))),
    Semaphore.withPermits(syncing, 1),
    Effect.flatMap((result) => Queue.offer(queues.results, { _tag: "Result", result })),
    Effect.uninterruptible
  );

  // Moving a directory reports only the directory, whose path no include glob matches, so a rename of a directory
  // (or of a path now gone) under an include root rescans.
  const movesTree = (absolute: string): boolean =>
    includeRoots.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}${sep}`)) &&
    isDirectoryOrGone(absolute);
  const alters = Effect.fnUntraced(function* (change: Change) {
    if (change.path === null) {
      return true;
    }

    if (catalogs.has(change.path)) {
      const ours = (yield* Ref.get(written)).get(change.path);

      if (ours === undefined || readText(change.path) !== ours) {
        return true;
      }
    } else if (isProjectSource(config, change.path)) {
      return true;
    }

    return change.event === "rename" && movesTree(change.path);
  });
  // Whether a batch holds a change that can alter a catalog. The stop gate is at intake: a batch admitted before the
  // stop may still queue a trigger, whose pending sync the stop drops as it interrupts the debounce.
  const classify = Effect.fnUntraced(function* (batch: ReadonlyArray<Change>) {
    for (const change of batch) {
      if (yield* alters(change)) {
        return true;
      }
    }

    return false;
  });
  // Done once the first sync has run and its result and the ready line are queued: classification starts then.
  const firstSynced = yield* Deferred.make<void>();
  const classifying = Deferred.await(firstSynced).pipe(
    Effect.andThen(
      Queue.take(queues.intake).pipe(
        Effect.flatMap((batch) => classify(batch).pipe(Semaphore.withPermits(syncing, 1))),
        Effect.flatMap((fires) => (fires ? Queue.offer(triggers, undefined) : Effect.void)),
        Effect.forever
      )
    )
  );

  // A quiet period: true when the debounce passes with no trigger, false when a trigger restarts it. Its timeout is a
  // relative sleep (the live clock's setTimeout, not a wall-clock deadline), so a wall-clock correction neither delays
  // nor hastens a sync.
  const quiet = Queue.take(triggers).pipe(
    Effect.as(false),
    Effect.timeoutOrElse({ duration: DEBOUNCE_MS, orElse: () => Effect.succeed(true) })
  );
  const debouncing = Effect.gen(function* () {
    for (;;) {
      yield* Queue.take(triggers);
      let settled = false;

      while (!settled) {
        settled = yield* quiet;
      }

      yield* sync;
    }
  });

  // A directory the config excludes holds no source; one holding a catalog is still walked.
  const prune = (directory: string): boolean =>
    isExcludedDirectory(config, directory) &&
    ![...catalogs].some((catalog) => catalog.startsWith(`${directory}${sep}`));
  // The stop gate, at delivery: each warning and change is admitted at once, synchronously, as the source delivers it
  // (its warnings to the writer, its changes to classification), or from the stop on not at all. What was admitted
  // before the stop is the stop's to drain.
  const admit = (item: Intake): void => {
    if (!isHalted()) {
      Queue.offerAllUnsafe(
        queues.results,
        item.problems.map((problem) => failed(problem))
      );

      if (item.changes.length > 0) {
        Queue.offerUnsafe(queues.intake, item.changes);
      }
    }
  };
  const roots = watchRoots(includeRoots, [...catalogs]);
  // Done once the trees are watched, with the first walks' warnings; failed with a watcher's start failure.
  const started = yield* Deferred.make<ReadonlyArray<Problem>>();
  const sources = yield* Stream.runDrain(
    mode._tag === "poll"
      ? polledTrees(roots, mode.intervalMs, prune, admit, started)
      : nativeTrees(roots, fileEvents, admit, started)
  ).pipe(Effect.forkScoped({ startImmediately: true }));
  // The first sync, then its result and the ready line, in one step that a stop waits for.
  const firstSync = sync.pipe(
    Effect.andThen(Queue.offer(queues.results, { _tag: "Ready" })),
    Effect.andThen(Deferred.succeed(firstSynced, undefined)),
    Effect.uninterruptible
  );

  // The stop, run once, whoever asks first; a second ask waits for the first. The sources go first, so the watchers
  // close at once; then the workers (a running sync, the first one included, is uninterruptible, so this waits for it
  // and its result); then the writer drains. It ends as the writing ended, and then as the sources closed: a watcher
  // that failed to close is a failure after every report.
  const workers: Array<Fiber.Fiber<unknown>> = [];
  const finished = yield* Deferred.make<void>();
  const shutdown = Effect.suspend(() => {
    if (stopping) {
      return Deferred.await(finished);
    }

    stopping = true;

    return Effect.gen(function* () {
      yield* Fiber.interrupt(sources);
      const closed = yield* Fiber.await(sources);
      yield* Fiber.interruptAll(workers);
      yield* Queue.end(queues.results);
      yield* Fiber.join(writing);

      if (Exit.isFailure(closed) && Cause.hasDies(closed.cause)) {
        return yield* Effect.die(Cause.squash(closed.cause));
      }
    }).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(finished, exit)),
      Effect.uninterruptible,
      Effect.andThen(Deferred.await(finished))
    );
  });
  // The stop signal, or a write that fails for good, stops the watch at once, the first sync's included; `done`
  // reports how it ended.
  yield* Effect.raceFirst(Deferred.await(stop), Deferred.await(fatal)).pipe(
    Effect.andThen(Effect.exit(shutdown)),
    Effect.forkScoped
  );
  // Whether `done` was asked for, so its caller has the stop's outcome: a scope that closes after it only waits.
  let observed = false;
  // A scope closed before (or without) `done` stops the watch the same way, during the first sync too. Added after the
  // sources and the stop, so it runs before their own finalizers.
  yield* Effect.addFinalizer(() => (observed ? Effect.asVoid(Effect.exit(shutdown)) : shutdown));

  const firstWalk = yield* Effect.raceFirst(
    Deferred.await(started),
    Fiber.join(sources).pipe(
      Effect.andThen(Effect.die(new Error("the watch's sources ended before they started")))
    )
  );
  yield* Queue.offerAll(
    queues.results,
    firstWalk.map((problem) => failed(problem))
  );
  // Every worker starts here, under the stop: the first sync, classification (which waits for it) and the debounce.
  for (const worker of [firstSync, classifying, debouncing]) {
    workers.push(yield* Effect.forkScoped(worker));
  }
  yield* Deferred.await(firstSynced).pipe(Effect.raceFirst(Deferred.await(finished)));

  const done = Effect.suspend(() => {
    observed = true;

    return Effect.raceFirst(Deferred.await(stop), Deferred.await(fatal)).pipe(Effect.andThen(shutdown));
  });
  const reported = Effect.raceFirst(
    Deferred.await(readyWritten),
    Fiber.await(writing).pipe(
      Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.void))
    )
  );

  return { done, reported } satisfies Watching;
});

/**
 * Start a watch outside an Effect program: `watchCatalogs` on its own scope, with the synchronous extract.
 *
 * @param config - The project config.
 * @param report - Called with each result, in order; one that throws is called again with that sync's `SyncFailed`.
 *   When that throws too, the watch ends: on the first sync's result, by rejecting the start; later, by throwing the
 *   error on the host's event loop.
 * @param mode - Where change events come from; native file events unless the caller polls.
 * @returns The running watch, once the first sync's result is reported. Rejects with the watch's start failure, or
 *   the first result's report failure, after the watch has stopped and closed every watcher it started.
 */
export async function watchProject(
  config: ProjectConfig,
  report: (result: SyncResult) => void,
  mode: WatchMode = NATIVE
): Promise<ProjectWatcher> {
  const scope = Scope.makeUnsafe();
  const stop = Deferred.makeUnsafe<void>();
  // The extract's and the file events' layers live in the watch's scope, for the whole watch.
  const start = await Effect.runPromiseExit(
    Layer.buildWithScope(Layer.merge(CatalogSync.layer(), FileEvents.layer()), scope).pipe(
      Effect.flatMap((services) =>
        watchCatalogs(config, mode, stop, {
          report: (result) =>
            Effect.sync(() => {
              report(result);
            }),
          ready: Effect.void,
        }).pipe(Scope.provide(scope), Effect.provideContext(services))
      ),
      Effect.tap((started) => started.reported)
    )
  );

  if (Exit.isFailure(start)) {
    // The scope's stop closes the watchers; the start's failure is the one to report.
    await Effect.runPromiseExit(Scope.close(scope, Exit.void));
    throw Cause.squash(start.cause);
  }

  const watching = start.value;

  // Whether the watch's end is someone else's to report: the host's, once it asks the watch to stop, or the event
  // loop's, once a failure that ended the watch was thrown there.
  let closing = false;
  const ended = Effect.runPromiseExit(watching.done.pipe(Effect.ensuring(Scope.close(scope, Exit.void))));
  void ended.then((exit) => {
    // Nothing is left to report a failure that ends the watch: it ends the host, as a throwing report always did.
    if (!closing && Exit.isFailure(exit)) {
      closing = true;
      queueMicrotask(() => {
        throw Cause.squash(exit.cause);
      });
    }
  });

  return {
    close: () => {
      const reports = !closing;
      closing = true;
      Deferred.doneUnsafe(stop, Effect.void);

      return ended.then((exit) => {
        if (reports && Exit.isFailure(exit)) {
          throw Cause.squash(exit.cause);
        }
      });
    },
  };
}

// The platform's recursive file events for every tree, as one Stream whose scope holds the listeners: they open as it
// starts (`started` then succeeds, or fails with a listener's start failure, the ones already open closing with the
// Stream) and close as it ends, so a stop that interrupts it ends every event at once. Each event is admitted as it is
// delivered, so none waits in a buffer a stop could drop. A listener's error leaves its tree unwatched.
function nativeTrees(
  dirs: ReadonlyArray<string>,
  fileEvents: FileEvents["Service"],
  admit: (item: Intake) => void,
  started: Deferred.Deferred<ReadonlyArray<Problem>>
): Stream.Stream<never> {
  return Stream.callback<never>(() =>
    Effect.forEach(
      dirs,
      (dir) =>
        fileEvents.watch(dir, {
          change: (event, filename) => {
            admit({
              problems: [],
              changes: [{ event, path: filename === null ? null : join(dir, filename) }],
            });
          },
          error: (error) => {
            admit({
              problems: [
                {
                  code: "WatchFailed",
                  message: `stopped watching ${dir}: ${error.message}`,
                  fix: "restart `elmera-intl extract --watch`",
                },
              ],
              changes: [],
            });
          },
        }),
      { discard: true }
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Deferred.succeed(started, []) : Deferred.failCause(started, exit.cause)
      )
    )
  );
}

// What a poll compares a path by: nanosecond change and modification times and the size, so a rewrite within one
// millisecond still differs.
type Entry = { readonly directory: boolean; readonly stamp: string };

// One walk of a tree: its entries by path relative to the root, and the directories it could not read.
type Snapshot = {
  readonly entries: ReadonlyMap<string, Entry>;
  readonly unreadable: ReadonlyMap<string, Error>;
};

// The tree one level at a time, so a directory `prune` rejects (node_modules, an excluded one) is listed by its parent
// but never read, and one that cannot be read is recorded while the rest of the tree is still walked.
function snapshot(root: string, prune: (directory: string) => boolean): Snapshot {
  const entries = new Map<string, Entry>();
  const unreadable = new Map<string, Error>();
  const pending = [root];

  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let names: ReadonlyArray<string> = [];

    try {
      names = readdirSync(directory, { encoding: "utf8" });
    } catch (error) {
      unreadable.set(directory, error instanceof Error ? error : new Error(String(error)));
    }

    for (const name of names) {
      const path = join(directory, name);
      let stats: BigIntStats | undefined;

      try {
        stats = statSync(path, { bigint: true, throwIfNoEntry: false });
      } catch {
        stats = undefined;
      }

      if (stats === undefined) {
        continue;
      }

      const isDirectory = stats.isDirectory();
      entries.set(relative(root, path), {
        directory: isDirectory,
        stamp: isDirectory ? "" : `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`,
      });

      if (isDirectory && name !== "node_modules" && !prune(path)) {
        pending.push(path);
      }
    }
  }

  return { entries, unreadable };
}

// Polled file events for every tree, shaped as the native ones: "rename" for a path that appeared or went away (a
// moved directory included), "change" for a file whose stamp moved. Each tree's first walk is taken as the Stream
// starts, before the caller's first sync (`started` then succeeds with their warnings), so no edit after it is missed.
// Then each tree walks every `intervalMs` from its own first walk, on the monotonic clock (a wall-clock step moves no
// walk): a walk that runs late, behind a slow first sync or another tree's slow walk, does not move the next one,
// ticks missed meanwhile are skipped rather than piled up, and a tree's walks never overlap. A walk's changes and the
// directories it newly cannot read are one item, admitted as the walk ends.
function polledTrees(
  dirs: ReadonlyArray<string>,
  intervalMs: number,
  prune: (directory: string) => boolean,
  admit: (item: Intake) => void,
  started: Deferred.Deferred<ReadonlyArray<Problem>>
): Stream.Stream<void> {
  const interval = BigInt(intervalMs) * 1_000_000n;

  return Stream.unwrap(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const trees = dirs.map((dir) => {
        const first = snapshot(dir, prune);

        return { dir, first, walked: clock.monotonicTimeNanosUnsafe() };
      });
      yield* Deferred.succeed(
        started,
        trees.flatMap(({ first }) => newlyUnreadable(first, undefined))
      );

      return Stream.mergeAll(
        trees.map(({ dir, first, walked }) => {
          let previous = first;
          let due = walked + interval;
          // Waits for the tree's next tick, then times the one after it from its own cadence.
          const tick = Effect.gen(function* () {
            const now = clock.monotonicTimeNanosUnsafe();

            if (now < due) {
              yield* Effect.sleep(Duration.nanos(due - now));
            }

            const woke = clock.monotonicTimeNanosUnsafe();
            due += interval * ((woke > due ? (woke - due) / interval : 0n) + 1n);
          });
          const walk = Effect.sync(() => {
            const current = snapshot(dir, prune);
            const before = previous;
            previous = current;
            admit({ problems: newlyUnreadable(current, before), changes: changes(dir, before, current) });
          });

          return Stream.fromEffectRepeat(tick.pipe(Effect.andThen(walk)));
        }),
        { concurrency: "unbounded" }
      );
    })
  );
}

// What moved between two walks of a tree.
function changes(dir: string, previous: Snapshot, current: Snapshot): ReadonlyArray<Change> {
  const moved: Array<Change> = [];

  for (const [name, entry] of current.entries) {
    const before = previous.entries.get(name);

    if (before === undefined || before.directory !== entry.directory) {
      moved.push({ event: "rename", path: join(dir, name) });
    } else if (before.stamp !== entry.stamp) {
      moved.push({ event: "change", path: join(dir, name) });
    }
  }

  for (const name of previous.entries.keys()) {
    if (!current.entries.has(name)) {
      moved.push({ event: "rename", path: join(dir, name) });
    }
  }

  return moved;
}

// The directories a walk could not read that the walk before it could.
function newlyUnreadable(current: Snapshot, before: Snapshot | undefined): ReadonlyArray<Problem> {
  return [...current.unreadable]
    .filter(([directory]) => before?.unreadable.has(directory) !== true)
    .map(([directory, error]) => ({
      code: "WatchFailed",
      message: `cannot read ${directory} (${error.message}), so changes under it are not seen`,
      fix: `make it readable, or exclude it in ${CONFIG_FILE}; the rest of the project is still watched`,
    }));
}

// Each include pattern's static prefix: the directory its matches live under.
function includePrefixes(config: ProjectConfig): Array<string> {
  return config.include.map((pattern) => {
    const segments = pattern.split("/");
    const glob = segments.findIndex((segment) => GLOB_CHARS.test(segment));

    return join(config.root, ...(glob === -1 ? segments.slice(0, -1) : segments.slice(0, glob)));
  });
}

// Each include root and each catalog's directory (the nearest existing ancestor of either), minus any inside another:
// one recursive watch per tree.
function watchRoots(includeRoots: ReadonlyArray<string>, catalogs: ReadonlyArray<string>): Array<string> {
  const dirs = [...includeRoots, ...catalogs.map((path) => dirname(path))].map((dir) => nearestExisting(dir));

  return [...new Set(dirs)]
    .toSorted()
    .filter((dir, _index, all) => !all.some((other) => other !== dir && dir.startsWith(`${other}${sep}`)));
}

// A catalog deleted or replaced by a directory reads as changed.
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Runs in a watch callback, where a throw would end the host: a path that cannot be read counts as gone.
function isDirectoryOrGone(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? true;
  } catch {
    return true;
  }
}

/**
 * The path itself when it exists, else its nearest existing ancestor.
 *
 * @param dir - An absolute path.
 * @returns An existing absolute path.
 */
export function nearestExisting(dir: string): string {
  const parent = dirname(dir);

  return existsSync(dir) || parent === dir ? dir : nearestExisting(parent);
}
