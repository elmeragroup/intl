// A Catalog sync: what it read, what it may write over, what it wrote, what it left behind, and whether a catalog still
// reads as that. Two entry points, one per caller, over one plan: `extractCatalogs` (`elmera-intl extract`), the
// developer's own command, writes over whatever a catalog holds; `syncCatalogs` (each sync of a watch) never writes over
// a translator's save, and never takes its own write for a save. What each decides from what it read is pure, in
// `catalog-plan.ts`; its file-system edges are `catalog-files.ts`'s.
import * as Effect from "effect/Effect";

import { CatalogFiles, readCatalog, readRegularText } from "./catalog-files";
import type { CatalogPlan, CatalogText, WrittenCatalog } from "./catalog-plan";
import { mergeCatalogs } from "./catalog-plan";
import type { UnusedEntries } from "./po";
import type { Problem } from "./problem";
import { scanProject } from "./project";
import type { ProjectConfig } from "./project-config";

/** What a one-shot extract did. */
export type ExtractReport = {
  readonly problems: ReadonlyArray<Problem>;
  readonly messages: number;
  /** The catalogs it wrote. */
  readonly written: ReadonlyArray<string>;
};

/** What a watched sync left in the project's catalogs. */
export type CatalogRecord = {
  /**
   * Whether the catalog at `path` still reads exactly what the sync left in it: a change to it is then the sync's own.
   * Reads the catalog when asked, without blocking (`readRegularText`).
   */
  readonly untouched: (path: string) => boolean;
};

/** No record: every catalog change is a change. */
export const NO_RECORD: CatalogRecord = { untouched: () => false };

/**
 * What one watched sync did. A sync with problems (`Failed`, exactly when there is at least one) wrote nothing and left
 * no record.
 */
export type CatalogSyncResult =
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> }
  | {
      readonly _tag: "Synced";
      /** The catalogs it wrote. */
      readonly written: ReadonlyArray<string>;
      /** A catalog was saved after the sync read it, so it wrote nothing more; another sync must follow. */
      readonly superseded: boolean;
      /** What it left. */
      readonly left: CatalogRecord;
    };

/** What `writeGuarded` did: each file written with its text, and what the guard judged them by. */
type GuardedWrites = {
  readonly written: ReadonlyArray<WrittenCatalog>;
  /**
   * A PO changed after it was read, so the sync stopped before writing it: `written` holds what it wrote before,
   * nothing when the change was there before the first write.
   */
  readonly superseded: boolean;
  /** Each catalog path's text as the plan read it (undefined: absent), by the exact path read and written. */
  readonly read: ReadonlyMap<string, string | undefined>;
  /** The texts this sync wrote, by the snapshot of the path each went to (`isOwnWrite`). */
  readonly own: OwnWrites;
};

/**
 * Extract messages and write each locale's PO, for `elmera-intl extract`: drops entries no source uses, writes over
 * whatever a catalog holds, keeps no record. Existing translations, flags and the files are kept when unchanged.
 * Writes nothing when any source or catalog fails.
 *
 * @param config - The project config.
 * @returns The problems (if any), the message count and the files written; fails with `ProjectIoFailed` on I/O the
 *   commands do not classify.
 */
export const extractCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.extractCatalogs")(function* (
  config: ProjectConfig
) {
  const { problems, messages, outputs } = yield* planCatalogs(config, "drop");

  if (problems.length > 0) {
    return { problems, messages, written: [] } satisfies ExtractReport;
  }

  // Each output over whatever its path holds, skipping one whose text is unchanged (its mtime stays).
  const files = yield* CatalogFiles;
  const written: Array<string> = [];
  for (const output of outputs) {
    if ((yield* files.write(output.path, output.text, { _tag: "Overwrite" })) === "written") {
      written.push(output.path);
    }
  }

  return { problems, messages, written } satisfies ExtractReport;
});

/**
 * One sync of a watch: keeps entries no source uses, and never writes over a catalog saved since it was read. A clean
 * sync takes its record after its last write, reading back each catalog it read (each it wrote, when superseded).
 *
 * @param config - The project config.
 * @returns `Failed` with the problems, or `Synced` with the files written, whether a save superseded it, and the record
 *   it left; fails with `ProjectIoFailed` on I/O the commands do not classify.
 */
export const syncCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.syncCatalogs")(function* (
  config: ProjectConfig
) {
  const plan = yield* planCatalogs(config, "keep");

  if (plan.problems.length > 0) {
    return { _tag: "Failed", problems: plan.problems } satisfies CatalogSyncResult;
  }

  const writes = yield* writeGuarded(plan);

  return {
    _tag: "Synced",
    written: writes.written.map(({ path }) => path),
    superseded: writes.superseded,
    left: recordOf(ownTexts(writes)),
  } satisfies CatalogSyncResult;
});

// Each locale's PO, in the config's order, keyed by the exact path the storage reads and writes. Every locale's path is
// a string of its own, which the config guarantees (`sharedCatalogPath`: unique locale identifiers, no `..` after
// `{locale}`), so each is read once with no dedupe; paths that still name one file (a link, a hard link) are known to
// the write guard by their content, not by asking the storage.
const snapshotCatalogs = /* @__PURE__ */ Effect.fnUntraced(function* (config: ProjectConfig) {
  const catalogs: Array<CatalogText> = [];
  for (const locale of config.locales) {
    catalogs.push(yield* readCatalog(config, locale));
  }

  return catalogs;
});

/**
 * Scan the sources, read each PO and merge: every catalog a sync would write, and the POs it read. Its scan reuses the
 * runtime's parse cache (`SourceCaches`).
 *
 * @param config - The project config.
 * @param unused - Whether entries no source uses any more are dropped (`extract`) or kept (`extract --watch`).
 * @returns The problems (if any), the message count, the POs read and the outputs.
 */
const planCatalogs = /* @__PURE__ */ Effect.fnUntraced(function* (
  config: ProjectConfig,
  unused: UnusedEntries
) {
  const scanned = yield* scanProject(config);

  if (scanned._tag === "Failed") {
    return { problems: scanned.problems, messages: 0, read: new Map(), outputs: [] } satisfies CatalogPlan;
  }

  if (scanned.unmatched.length > 0) {
    return {
      problems: scanned.unmatched,
      messages: scanned.messages.length,
      read: new Map(),
      outputs: [],
    } satisfies CatalogPlan;
  }

  return mergeCatalogs(yield* snapshotCatalogs(config), scanned.messages, unused);
});

/**
 * Write a clean plan's catalogs, skipping each whose text is unchanged. Writes nothing when a PO changed after the plan
 * read it, and stops before a target that changed since (one saved while an earlier catalog was written): each write
 * checks its target in the same storage operation.
 *
 * @param plan - What `planCatalogs` read and would write, with no problems.
 * @returns Each file written with its text, whether a save superseded the sync, and what the guard judged them by.
 */
const writeGuarded = /* @__PURE__ */ Effect.fnUntraced(function* (plan: CatalogPlan) {
  // Filled as writes succeed: the one index the guard below and the watch's record judge a text by.
  const own = new Map<string | undefined, Set<string>>();
  const files = yield* CatalogFiles;

  // Before the first write, every distinct path against its own snapshot: a save to any of them since the plan read it
  // supersedes the sync with nothing written, whichever file it names now.
  for (const [path, text] of plan.read) {
    if ((yield* files.read(path)) !== text) {
      return { written: [], superseded: true, read: plan.read, own } satisfies GuardedWrites;
    }
  }

  // A path may hold its own snapshot, or a text of this sync's own (`isOwnWrite`); anything else is a save since,
  // which this sync never writes over.
  const written: Array<WrittenCatalog> = [];
  for (const output of plan.outputs) {
    const snapshot = plan.read.get(output.path);
    const outcome = yield* files.write(output.path, output.text, {
      _tag: "IfHolds",
      holds: (current) => current === snapshot || isOwnWrite(own, snapshot, current),
    });

    if (outcome === "changed") {
      return { written, superseded: true, read: plan.read, own } satisfies GuardedWrites;
    }

    if (outcome === "written") {
      written.push(output);
      own.set(snapshot, (own.get(snapshot) ?? new Set<string>()).add(output.text));
    }
  }

  return { written, superseded: false, read: plan.read, own } satisfies GuardedWrites;
});

/** The texts one sync wrote, by the snapshot the path each went to held at the read (undefined: absent). */
type OwnWrites = ReadonlyMap<string | undefined, ReadonlySet<string>>;

/**
 * Whether a catalog path whose snapshot is `snapshot` holding `text` holds one of the sync's own writes: the one
 * definition the write guard and the watch's record of its own writes share. A text this sync wrote to a path with the
 * same snapshot is its own: paths that name one file (a link, a hard link) read one snapshot once the sync's check
 * before its first write passed. So is a text it wrote to a path that was absent at the read: that write may create a
 * directory (one a `..` before the locale climbs out of) that makes it, or a later path, reach a file another path
 * names through a link, and the sync cannot know which. Anything else, a text this sync wrote over another present
 * snapshot included, is a save since: a catalog a translator copies onto another mid-sync is kept when the copied
 * catalog existed at the read. Left: when two paths' snapshots are one text, or a copied catalog was just created, a
 * copy between them cannot be told from the sync's own write through a link, since content is all this knows.
 *
 * @param own - What the sync wrote, by snapshot.
 * @param snapshot - The path's text as the sync read it (undefined: absent).
 * @param text - What the path holds now (undefined: absent).
 * @returns Whether that is a text of the sync's own for the path.
 */
function isOwnWrite(own: OwnWrites, snapshot: string | undefined, text: string | undefined): boolean {
  return (
    text !== undefined &&
    ((own.get(snapshot)?.has(text) ?? false) || (own.get(undefined)?.has(text) ?? false))
  );
}

// The record a clean sync leaves: each catalog path's own text, seeded from the plan's snapshots (`writes.read`) with
// its writes over them, then, when it wrote anything, what each path reads back right after the writes (no file event
// is classified in between), where that is a text of the sync's own for the path (`isOwnWrite`, the write guard's own
// definition, over the sync's own index): links name one file, so an earlier locale's path reads the last locale's
// write. A read-back that is anything else (a save, a copy that landed since the writes) leaves the path's record as it
// was, so it is a change. A superseded sync records only the paths it wrote: the others' snapshots may be stale, and
// the retry it queued reads them again.
function ownTexts(writes: GuardedWrites): ReadonlyMap<string, string> {
  const record = new Map<string, string>();
  if (!writes.superseded) {
    for (const [path, text] of writes.read) {
      if (text !== undefined) {
        record.set(path, text);
      }
    }
  }
  for (const { path, text } of writes.written) {
    record.set(path, text);
  }

  if (writes.written.length > 0) {
    // A clean plan read every configured path, absent ones included, in the config's order.
    for (const path of writes.superseded ? writes.written.map((output) => output.path) : writes.read.keys()) {
      const back = readRegularText(path);

      if (back !== undefined && isOwnWrite(writes.own, writes.read.get(path), back)) {
        record.set(path, back);
      }
    }
  }

  return record;
}

// A record over each catalog path's own text: a catalog is untouched when its path reads exactly its own text. Links
// that name one file read back the last of their writes on each path (#15), and a catalog copied onto another later
// reads as none of the other's.
function recordOf(texts: ReadonlyMap<string, string>): CatalogRecord {
  return {
    untouched: (path) => {
      const ours = texts.get(path);

      return ours !== undefined && readRegularText(path) === ours;
    },
  };
}
