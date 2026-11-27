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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { basename, sep } from "node:path";

import { CatalogFiles, ioFailureReason } from "./catalog-files";
import type { CatalogRecord, CatalogSyncResult } from "./catalog-sync";
import { NO_RECORD, syncCatalogs } from "./catalog-sync";
import type { Problem } from "./problem";
import { isExcludedDirectory, isProjectSource, SourceCaches, SourceDiscovery } from "./project";
import { catalogIdentity, catalogPath, fileIdentity } from "./project-catalogs";
import type { ProjectConfig } from "./project-config";
import type { ProjectFormats } from "./project-formats-service";
import type { ProjectServices } from "./project-services";
import { projectServices } from "./project-services";
import type { Change, Intake } from "./watch-trees";
import {
  catalogTargets,
  FileEvents,
  includePrefixes,
  listenNative,
  movesTree,
  startPolling,
  treePath,
  watchRoots,
} from "./watch-trees";

/** What one sync did, or, in a watch that follows its config (`followConfig`), that it restarts on an edit. */
export type SyncResult =
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Unchanged" }
  /** A catalog was saved during the sync before it wrote anything, so it wrote nothing; another sync follows. */
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> }
  /** The config's text or root changed (see `followConfig`): written as it is accepted, before the watch restarts. */
  | { readonly _tag: "ConfigChanged" }
  /** The watch a restart started has written its first sync's result. */
  | { readonly _tag: "Restarted" };

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

/**
 * Where change events come from. `native` is the platform's file events (`fs.watch`, recursive); `poll` stats every
 * watched file again `intervalMs` after its previous pass over them ends, for hosts whose native events arrive late or
 * not at all (a container's bind mount, a network drive, a macOS whose fseventsd is saturated): slower to notice and
 * costlier, but it depends on no event daemon.
 */
export type WatchMode = { readonly _tag: "native" } | { readonly _tag: "poll"; readonly intervalMs: number };

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

/** A sync's extract failed on I/O the extractor does not classify, such as a file a checkout deletes mid-scan. */
export class SyncFailed
  extends /* @__PURE__ */ Schema.TaggedError<SyncFailed>()("SyncFailed", {
    /** The thrown error's message. */
    message: Schema.String,
  }) {}

/** What a sync's extract runs on: the commands' services but the formats, which only `check` loads. */
export type SyncServices = Exclude<ProjectServices, ProjectFormats>;

/**
 * One sync's extract: what the watch runs per burst of changes. A service so a test can count a sync, hold it, kill it,
 * or stand in its result. A save between a sync's read and its writes, or between its writes and the record it takes,
 * lands inside the step, so a test makes it through the storage (`CatalogFiles`), never here.
 */
export class CatalogSync
  extends /* @__PURE__ */ Context.Service<
    CatalogSync,
    {
      /** Sync the project's messages into its catalogs, as `syncCatalogs` does. */
      readonly extract: (config: ProjectConfig) => Effect.Effect<CatalogSyncResult, SyncFailed>;
    }
  >()("elmera-intl-tools/CatalogSync")
{
  /**
   * `syncCatalogs`, its failure a `SyncFailed`: I/O it does not classify, and, as when the extract was one
   * synchronous call whose every throw was the sync's failure, any defect of the step (the merge's and the record's
   * included). The watch reports it and retries on the next change.
   *
   * @returns A layer whose extract runs `syncCatalogs` on the host's services.
   */
  static layer(): Layer.Layer<CatalogSync, never, SyncServices> {
    return Layer.effect(
      CatalogSync,
      Effect.gen(function* () {
        // Only these services, never the rest of the builder's context: its current span (the layer's build) would
        // otherwise parent every sync's spans, which belong under `CatalogSync.extract`.
        const services = Context.pick(
          CatalogFiles,
          FileSystem.FileSystem,
          Path.Path,
          SourceDiscovery,
          SourceCaches
        )(yield* Effect.context<SyncServices>());

        return {
          extract: Effect.fn("CatalogSync.extract")(function* (config: ProjectConfig) {
            return yield* syncCatalogs(config).pipe(
              Effect.provideContext(services),
              Effect.mapError((failure) => new SyncFailed({ message: ioFailureReason(failure) })),
              Effect.catchDefect((defect) =>
                Effect.fail(
                  new SyncFailed({ message: defect instanceof Error ? defect.message : String(defect) })
                )
              )
            );
          }),
        };
      })
    );
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

/**
 * What a watch's writer writes, in order: a result (a sync's, or a problem that leaves part of the project unwatched),
 * or the ready line.
 */
export type Output = { readonly _tag: "Result"; readonly result: SyncResult } | { readonly _tag: "Ready" };

/**
 * A problem that leaves part of the project unwatched, as the output its writer writes.
 *
 * @param problem - The problem.
 * @returns A failed result naming it.
 */
export const failed = (problem: Problem): Output => ({
  _tag: "Result",
  result: { _tag: "Failed", problems: [problem] },
});

// A superseded sync that wrote catalogs before it stopped reports them: they are written, and the retry follows.
function syncResult(result: CatalogSyncResult): SyncResult {
  return result._tag === "Failed"
    ? { _tag: "Failed", problems: result.problems }
    : result.written.length > 0
      ? { _tag: "Written", files: result.written }
      : result.superseded
        ? { _tag: "Superseded" }
        : { _tag: "Unchanged" };
}

// The configured catalogs by identity (`fileIdentity`): which catalog, or catalogs (several locales' paths that name
// one file through a link), a changed file is, each by the path `catalogPath` spells, which the sync wrote and keyed its
// record by; and by the names those files go by (`nameKey`), which a change's name must have before its identity is
// looked up.
type CatalogIdentities = {
  readonly byName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byIdentity: ReadonlyMap<string, ReadonlyArray<string>>;
};

const NO_IDENTITIES: CatalogIdentities = { byName: new Map(), byIdentity: new Map() };

// A name as the prefilter compares it: in one Unicode form and lowercased, so a volume that folds case or
// normalisation still passes a catalog its config spells otherwise than the disk; the identity decides.
const nameKey = (path: string) => basename(path).normalize("NFC").toLowerCase();

// Each catalog's identity, as the kernel resolves its spelled path now. A catalog whose `..` follows a directory that
// does not exist reaches no file (`CatalogClimbsMissing`) and has none; a change to it is still matched as spelled.
function identifyCatalogs(catalogs: ReadonlySet<string>): CatalogIdentities {
  const byName = new Map<string, Set<string>>();
  const byIdentity = new Map<string, Array<string>>();
  const name = (path: string, catalog: string) => {
    byName.set(nameKey(path), (byName.get(nameKey(path)) ?? new Set()).add(catalog));
  };

  for (const catalog of catalogs) {
    name(catalog, catalog);
    const identity = catalogIdentity(catalog);

    if (identity !== undefined) {
      name(identity, catalog);
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), catalog]);
    }
  }

  return { byName, byIdentity };
}

// The configured catalogs a changed path is, by their spelled paths: the one it spells, and every one whose file it
// names by identity. Only a path whose name a catalog goes by is looked up, so a source's change costs no system call.
// The last sync's identities answer the common case. One they miss is asked of each catalog by that name as the kernel
// resolves it now (`catalogIdentity`): a file renamed over a catalog's file link since (an editor's atomic save) is
// the catalog now, while the identities still name the link's old target. The lookups are synchronous, as the record's
// read of the catalog that follows them (`readRegularText`) and `movesTree`'s stat are: they read the catalog's own
// tree, so a mount that stalls them stalls those reads alike. A deleted file, or one renamed away, is resolved through
// its nearest existing ancestor, so it is still the catalog it was.
function catalogsAt(pipeline: Pipeline, identities: CatalogIdentities, path: string): ReadonlySet<string> {
  const spelled = pipeline.catalogs.has(path) ? [path] : [];
  const named = identities.byName.get(nameKey(path));

  if (named === undefined) {
    return new Set(spelled);
  }

  const identity = fileIdentity(path);
  const known =
    identities.byIdentity.get(identity) ??
    [...named].filter((catalog) => catalogIdentity(catalog) === identity);

  return new Set([...spelled, ...known]);
}

// What every stage of one watch shares.
type Pipeline = {
  readonly config: ProjectConfig;
  readonly catalogs: ReadonlySet<string>;
  readonly includeRoots: ReadonlyArray<string>;
  // The last sync's record of what it left in the catalogs (`CatalogRecord`), opaque to the watch: classification asks
  // it, under the permit, whether a changed catalog is `untouched`, and only then takes the change for our own write.
  readonly record: Ref.Ref<CatalogRecord>;
  // The catalogs' identities as each sync left them, resolved again under its permit, so classification matches a
  // change to the files that sync wrote: a link repointed since is followed from the next sync on.
  readonly identities: Ref.Ref<CatalogIdentities>;
  // Each admitted change, for classification.
  readonly intake: Queue.Queue<Change>;
  // Every output, in order, for the writer.
  readonly results: Queue.Queue<Output, Cause.Done>;
  // That a change can alter a catalog, for the debounce: coalesced, since one pending trigger restarts it as well as
  // many.
  readonly triggers: Queue.Queue<void>;
  // Held by a sync from its read until it has recorded its writes, and by each classification.
  readonly syncing: Semaphore.Semaphore;
  // Done once the watch must stop, and from then on the stop gate: the caller's stop signal, which the watch completes
  // itself the moment it halts on its own (a write that fails for good, a defect, its scope closing): whoever completed
  // it first started the stop.
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
    record: yield* Ref.make<CatalogRecord>(NO_RECORD),
    identities: yield* Ref.make(NO_IDENTITIES),
    intake: yield* Queue.unbounded<Change>(),
    results: yield* Queue.unbounded<Output, Cause.Done>(),
    triggers: yield* Queue.dropping<void>(1),
    syncing: yield* Semaphore.make(1),
    sourcesOpened: yield* Deferred.make<void>(),
    firstSynced: yield* Deferred.make<void>(),
    readyWritten: yield* Deferred.make<void>(),
  } satisfies Pipeline;
});

/**
 * Writes one result, written again as `SyncFailed` when its write fails; it dies when that write fails too. Each call
 * of `report` is deferred into the write, so a host's `report` that throws as it is called, before it returns an
 * effect, fails the write as one that fails inside its effect does.
 *
 * @template R - What the output's writes need.
 * @param output - Where the result is written.
 * @param result - The result.
 * @returns The write.
 */
export const writeResult = <R>(output: WatchOutput<R>, result: SyncResult) =>
  Effect.suspend(() => output.report(result)).pipe(
    Effect.catchDefect((defect) =>
      Effect.suspend(() =>
        output.report(syncFailed(defect instanceof Error ? defect.message : String(defect)))
      )
    )
  );

// The one writer: every output in order, each failed result written again as SyncFailed. A write that fails for good
// halts the watch and ends the writer with its failure.
function writer<R>(pipeline: Pipeline, output: WatchOutput<R>) {
  const write = (next: Output) => (next._tag === "Ready" ? output.ready : writeResult(output, next.result));

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
    const result = yield* catalogSync.extract(pipeline.config);
    // A sync with problems leaves no record: whatever its catalogs hold now, the next change to any of them syncs
    // (and a catalog it could not read is not read again here).
    yield* Ref.set(pipeline.record, result._tag === "Synced" ? result.left : NO_RECORD);

    // A superseded sync queues its retry itself, without waiting for another file event: the save that stopped it may
    // be judged the sync's own by the record, and then no event would start the retry.
    if (result._tag === "Synced" && result.superseded) {
      yield* Queue.offer(pipeline.triggers, undefined);
    }

    return syncResult(result);
  }).pipe(
    // A sync that failed leaves no record either.
    Effect.catchTag("SyncFailed", (failure) =>
      Ref.set(pipeline.record, NO_RECORD).pipe(Effect.as(syncFailed(failure.message)))
    ),
    // Once its writes are made, a catalog the sync created exists, so it has the identity the next save names.
    Effect.tap(() => Ref.set(pipeline.identities, identifyCatalogs(pipeline.catalogs))),
    Semaphore.withPermit(pipeline.syncing),
    Effect.flatMap((result) => Queue.offer(pipeline.results, { _tag: "Result", result })),
    Effect.uninterruptible
  );
}

// What classification judges a batch against: the record and the catalogs' identities as the last sync left them.
type Judged = { readonly record: CatalogRecord; readonly identities: CatalogIdentities };

// Whether a change can alter a catalog, against the last sync's record and identities as they stood when its batch was
// taken: a file that is a catalog the last sync did not leave untouched, however the config spells its path (each
// catalog it is asked by the path the sync wrote), a project source, or a rename that moved a tree under an include
// root.
function alters(pipeline: Pipeline, judged: Judged, change: Change): boolean {
  if (change.path === null) {
    return true;
  }

  const catalogs = catalogsAt(pipeline, judged.identities, change.path);

  if (catalogs.size > 0) {
    if ([...catalogs].some((catalog) => !judged.record.untouched(catalog))) {
      return true;
    }
  } else if (isProjectSource(pipeline.config, change.path)) {
    return true;
  }

  return change.event === "rename" && movesTree(pipeline.includeRoots, change.path);
}

// Classification, from the first sync on: every change admitted since the last one, under one permit (so never while a
// sync runs, and a catalog's change is judged by asking the last sync's record), queues one trigger when any can alter
// a catalog. A burst is one classification and one trigger.
const classifier = /* @__PURE__ */ Effect.fnUntraced(function* (pipeline: Pipeline) {
  yield* Deferred.await(pipeline.firstSynced);

  for (;;) {
    const changes = yield* Queue.takeAll(pipeline.intake);
    const fires = yield* Effect.all({
      record: Ref.get(pipeline.record),
      identities: Ref.get(pipeline.identities),
    }).pipe(
      Effect.map((judged) => changes.some((change) => alters(pipeline, judged, change))),
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

// The watch halts on its own (a write that fails for good, a defect, its scope closing): it completes the stop signal
// itself, so a stop asked for from then on never counts as the one that stopped it.
const haltOnOwn = (pipeline: Pipeline) => Deferred.succeed(pipeline.stop, undefined);

// The watch's own scope, and the two children its stop closes.
type Scopes = {
  readonly own: Scope.Scope;
  readonly sources: Scope.Closeable;
  readonly workers: Scope.Closeable;
};

/**
 * A watch's outcome, `ended`, handed to whoever takes `done`, who then owns reporting it; `unclaimed` is what a scope's
 * close ends as: the outcome, unless a caller took it, so an interrupted caller never hides a defect. The outcome has
 * one recipient: a `done` taken after the scope's close reported it ends clean. Each caller
 * claims the outcome in the step it begins to wait, and the scope's close honours every claim until its caller has
 * taken the outcome, declined it or been interrupted, so who reports it never rests on which fiber runs first.
 * `claiming` is that wait for a caller that may decline the outcome once the watch has ended (a start the host
 * stopped, whose end is `done`'s to report), which then ends clean, taking nothing, and that waits for it inside
 * `waiting` (a race with its other outcomes).
 *
 * @param ended - Waits for the watch's end, and ends as it did.
 * @returns `done` and `claiming`, for the callers, and `unclaimed`, for the scope's close.
 */
export function handOff(ended: Effect.Effect<void>) {
  // Whether a caller took the outcome, so the scope's close reports nothing; and whether the close reported it, so a
  // caller who takes it after the close takes nothing. Each is decided in one synchronous step.
  let delivered = false;
  let reported = false;
  // The callers waiting, each released once it has taken the outcome, declined it or been interrupted.
  const claims = new Set<Deferred.Deferred<void>>();
  const claiming = <A, E, R>(
    declines: () => boolean,
    waiting: (end: Effect.Effect<void>) => Effect.Effect<A, E, R>
  ) => {
    const end = Effect.exit(ended).pipe(
      Effect.flatMap((exit) =>
        Effect.suspend(() => {
          if (declines() || reported) {
            return Effect.void;
          }

          delivered = true;

          return exit;
        }).pipe(Effect.uninterruptible)
      )
    );

    // The claim and its release in one uninterruptible step, so no interruption lands between them and leaves a claim
    // the scope's close would wait on for ever; only the wait itself is interruptible.
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const claim = Deferred.makeUnsafe<void>();
        claims.add(claim);

        return restore(waiting(end)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              claims.delete(claim);
              Deferred.doneUnsafe(claim, Effect.void);
            })
          )
        );
      })
    );
  };

  return {
    done: claiming(
      () => false,
      (end) => end
    ),
    claiming,
    unclaimed: Effect.exit(ended).pipe(
      Effect.flatMap((exit) =>
        Effect.forEach([...claims], Deferred.await, { discard: true }).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (delivered) {
                return Effect.void;
              }

              reported = true;

              return exit;
            })
          )
        )
      )
    ),
  };
}

// The watch's one stop, and the outcome everyone who waits for it shares. One fiber runs it, uninterruptibly, once the
// stop signal comes (the gate, shut by the caller or a halt): it closes `sources`, so the watchers close at once; closes
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
  writes: Effect.Effect<void, never, R>
) {
  // A worker's defect: it halts the watch, and the stop ends with it.
  let defect: Cause.Cause<never> | undefined;
  const finished = yield* Deferred.make<void>();
  // The stop's outcome, for `done`'s caller or a start that failed with it.
  const outcome = handOff(Deferred.await(finished));
  const shutdown = Effect.fnUntraced(
    function* (writing: Fiber.Fiber<void>) {
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
      const stopping = yield* Deferred.await(pipeline.stop).pipe(
        Effect.andThen(shutdown(writing)),
        Effect.forkDetach
      );

      return { writing, stopping };
    }),
    ({ stopping }) =>
      haltOnOwn(pipeline).pipe(Effect.andThen(Fiber.await(stopping)), Effect.andThen(outcome.unclaimed))
  ).pipe(Scope.provide(scopes.own));

  return {
    // The writer, for a host that waits for its first writes.
    writing: fibers.writing,
    // Waits for the stop, then hands its outcome to the caller.
    done: outcome.done,
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
 * Returns once the trees are watched (a poll's first walks taken, the next ones timed from the first sync) and the first
 * sync has run, so no change after it returns is missed. A stop during the start (or before it) ends the start once the
 * stop has run, with no first sync unless that had begun, and with the stop's outcome when that is a failure.
 *
 * One stop, whatever asks first (the stop signal, a write that fails for good, a defect, a tree that fails to open, or
 * the caller's scope closing): the gate shuts, so nothing delivered after it is admitted; `sources` closes, so the
 * watchers close at once (a tree still opening first, so a watcher it is acquiring is closed too); `workers` closes,
 * dropping a pending sync and waiting for a running one; then every result already made is written. It ends as the
 * writing ended, then as the workers ended, then as the watchers closed. `done` delivers that outcome; when nothing
 * does (an interrupted `done`, or no `done`), the scope's close fails with it, so no defect is lost, and a `done` taken
 * after that ends clean, so none is reported twice.
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
  const { results } = pipeline;
  // The watch's own scope: closed in order whatever the caller's strategy, its stop first.
  const own = yield* Scope.fork(yield* Effect.scope, "sequential");
  const sources = yield* Scope.fork(own, "sequential");
  // `sources` closes `opening` before `watchers` (the last child first), so a watcher a tree is still acquiring as the
  // stop lands is held by `watchers` when that closes it.
  const watchers = yield* Scope.fork(sources, "sequential");
  const opening = yield* Scope.fork(sources, "sequential");
  const workers = yield* Scope.fork(own, "sequential");
  const owned = yield* ownedStop(pipeline, { own, sources, workers }, writer(pipeline, output));
  const isHalted = () => Deferred.isDoneUnsafe(stop);

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
  // The catalogs as the trees name them: a catalog spelled with `..` is watched and walked where the kernel climbs to.
  const treeCatalogs = [...pipeline.catalogs].map((catalog) => treePath(catalog));
  // A directory the config excludes holds no source; one holding a catalog is still walked.
  const prune = (directory: string): boolean =>
    isExcludedDirectory(config, directory) &&
    !treeCatalogs.some((catalog) => catalog.startsWith(`${directory}${sep}`));
  const roots = watchRoots(pipeline.includeRoots, treeCatalogs);
  // The trees open in `opening`, their watchers held by `watchers`; none once the stop has begun. A tree that fails to
  // open stops the watch, like any worker's defect.
  const open = Effect.suspend(() =>
    isHalted()
      ? Effect.void
      : (mode._tag === "poll"
          ? startPolling(
              roots,
              mode.intervalMs,
              prune,
              admit,
              owned.supervised,
              Deferred.await(pipeline.firstSynced)
            )
          : listenNative(roots, catalogTargets(roots, treeCatalogs), admit)
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

/** The services a watch runs on: the sync's extract, the file events, and the file system its config is read from. */
export type WatchServices = CatalogSync | FileEvents | FileSystem.FileSystem | Path.Path;

/**
 * The services a host provides its watch and its commands, in production: the project's services on Node (with the
 * session's own memos), the sync's extract on them, and Node's file events. Built once per session.
 *
 * @returns The layer.
 */
export function hostServices(): Layer.Layer<WatchServices | ProjectServices> {
  return Layer.mergeAll(Layer.provideMerge(CatalogSync.layer(), projectServices()), FileEvents.layer());
}
