// The CLI's two operations over a project: `extract` writes catalogs, `check` proves them in sync and compilable. Each
// is an effect over its edges (the scan, the formats module, the catalogs' reads and writes); what it decides from what
// it read is pure, in `catalog-plan.ts` and `catalog-check.ts`.
import * as Effect from "effect/Effect";
import { relative } from "node:path";

import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { checkLocale, checkSources, compileLocale } from "./catalog-check";
import { CatalogFiles, ioEdge } from "./catalog-files";
import type { CatalogPlan, CatalogText, WrittenCatalog } from "./catalog-plan";
import { mergeCatalogs } from "./catalog-plan";
import type { UnreachableArm } from "./compile";
import type { UnusedEntries } from "./po";
import type { Problem } from "./problem";
import type { ParseCache } from "./project";
import { scanProject } from "./project";
import { catalogPath } from "./project-catalogs";
import type { ProjectConfig } from "./project-config";
import { loadFormats } from "./project-formats";

/** What one command run found. Success has no problems. */
export type CommandReport = {
  readonly problems: ReadonlyArray<Problem>;
  /** Messages extracted from the sources. */
  readonly messages: number;
  /** Files written (extract only). */
  readonly written: ReadonlyArray<string>;
  /** Arms the compile's branch pass does not reach (check only): information, not problems. */
  readonly unreachable: ReadonlyArray<UnreachableArm>;
};

/** How `runExtract` merges and scans. */
export type ExtractOptions = {
  /** Whether entries no source uses any more are dropped (`extract`) or kept (`extract --watch`). */
  readonly unused: UnusedEntries;
  /** Parse results to reuse across runs; a one-shot run starts empty. */
  readonly cache: ParseCache;
  /**
   * What a PO saved between its read and the write does: `overwrite` writes over it (`extract`), `yield` writes
   * nothing more so the next sync merges the save (`extract --watch`, where a translator saves while a sync runs).
   */
  readonly concurrentSave: "overwrite" | "yield";
};

/** What `extractCatalogs` did: `runExtract`'s report, with each written file's text. */
export type ExtractResult = Omit<CommandReport, "written" | "unreachable"> & {
  readonly written: ReadonlyArray<WrittenCatalog>;
  /**
   * A PO changed after it was read, so (under `yield`) the sync stopped before writing it: `written` holds what it
   * wrote before, nothing when the change was there before the first write.
   */
  readonly superseded: boolean;
};

const scan = (config: ProjectConfig, cache: ParseCache) => ioEdge("scan", () => scanProject(config, cache));

// A locale's PO as it is now.
const readCatalog = /* @__PURE__ */ Effect.fnUntraced(function* (config: ProjectConfig, locale: string) {
  const files = yield* CatalogFiles;
  const path = catalogPath(config, locale);

  return {
    locale,
    path,
    shown: relative(config.root, path),
    text: yield* files.read(path),
  } satisfies CatalogText;
});

// Each locale's PO, in the config's order, each distinct path read once, keyed by the exact path the storage reads and
// writes: a locale whose path is another locale's string (a duplicate locale, a relative `{locale}/..` pattern, which
// `join` collapses) shares that read. Paths that differ are read each on their own, links and absolute `..` paths
// included, since only the kernel knows where `<link>/..` leads: the write guard knows a file several paths name by its
// content, not by asking the storage.
const snapshotCatalogs = /* @__PURE__ */ Effect.fnUntraced(function* (config: ProjectConfig) {
  const files = yield* CatalogFiles;
  const texts = new Map<string, string | undefined>();
  const catalogs: Array<CatalogText> = [];
  for (const locale of config.locales) {
    const path = catalogPath(config, locale);
    const text = texts.has(path) ? texts.get(path) : yield* files.read(path);
    texts.set(path, text);
    catalogs.push({ locale, path, shown: relative(config.root, path), text });
  }

  return catalogs;
});

/**
 * Extract messages and write each locale's PO. Existing translations, flags and the files are kept when unchanged.
 * Writes nothing when any source or catalog fails.
 *
 * @param config - The project config.
 * @param options - Merge mode and parse cache; by default a full sync that drops unused entries.
 * @returns The problems (if any), the message count and the files written; fails with `ProjectIoFailed` on I/O the
 *   commands do not classify.
 */
export const runExtract = /* @__PURE__ */ Effect.fn("elmera-intl.extract")(function* (
  config: ProjectConfig,
  options?: ExtractOptions
) {
  const { problems, messages, written } = yield* extractCatalogs(
    config,
    options ?? { unused: "drop", cache: new Map(), concurrentSave: "overwrite" }
  );

  return {
    problems,
    messages,
    written: written.map(({ path }) => path),
    unreachable: [],
  } satisfies CommandReport;
});

/**
 * `runExtract`, returning the text of each file it wrote: a watcher that reads a file back after the write could
 * read an edit saved since.
 *
 * @param config - The project config.
 * @param options - Merge mode, parse cache and what a concurrent save does.
 * @returns The problems (if any), the message count and each file written with its text.
 */
export const extractCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.extractCatalogs")(function* (
  config: ProjectConfig,
  options: ExtractOptions
) {
  return yield* writeCatalogs(yield* planCatalogs(config, options), options);
});

/**
 * Scan the sources, read each PO and merge: every catalog `writeCatalogs` would write, and the POs it read.
 *
 * @param config - The project config.
 * @param options - Merge mode and parse cache.
 * @returns The problems (if any), the message count, the POs read and the outputs.
 */
export const planCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.planCatalogs")(function* (
  config: ProjectConfig,
  options: ExtractOptions
) {
  const scanned = yield* scan(config, options.cache);

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

  return mergeCatalogs(yield* snapshotCatalogs(config), scanned.messages, options.unused);
});

/**
 * Write a plan's catalogs, skipping each whose text is unchanged. Writes nothing when the plan has problems. Under
 * `yield`, writes nothing when a PO changed after the plan read it, and stops before a target that changed since (one
 * saved while an earlier catalog was written): each write checks its target in the same storage operation.
 *
 * @param plan - What `planCatalogs` read and would write.
 * @param options - What a concurrent save does.
 * @returns The plan's problems and message count, and each file written with its text.
 */
export const writeCatalogs = /* @__PURE__ */ Effect.fn("elmera-intl.writeCatalogs")(function* (
  plan: CatalogPlan,
  options: ExtractOptions
) {
  const { problems, messages } = plan;

  if (problems.length > 0) {
    return { problems, messages, written: [], superseded: false } satisfies ExtractResult;
  }

  const files = yield* CatalogFiles;

  // Before the first write, every distinct path against its own snapshot: a save to any of them since the plan read it
  // supersedes the sync with nothing written, whichever file it names now.
  if (options.concurrentSave === "yield") {
    for (const [path, text] of plan.read) {
      if ((yield* files.read(path)) !== text) {
        return { problems, messages, written: [], superseded: true } satisfies ExtractResult;
      }
    }
  }

  // A path may hold its own snapshot, a text this sync wrote to a path with the same snapshot, or a text this sync wrote
  // to a path that was absent at the read. Through another path that names the same file (a link, a hard link, a name a
  // case-insensitive file system folds), a text written over the same snapshot is the sync's own write, since paths that
  // name one file read one snapshot once the check above passed. A write to an absent path may create a directory that
  // makes it, or a later path, reach a file another path already names, and the sync cannot know which, so its text is
  // the sync's own to every later write. Anything else, a text this sync wrote over another present snapshot included,
  // is a save since, which this sync never writes over: a catalog a translator copies onto another mid-sync is kept
  // when the copied catalog existed at the read. One the sync just created there is overwritten, since a content guard
  // cannot tell that copy from a created directory's reach.
  const ownTexts = new Map<string | undefined, Set<string>>();
  const written: Array<WrittenCatalog> = [];
  for (const output of plan.outputs) {
    const snapshot = plan.read.get(output.path);
    const own = ownTexts.get(snapshot) ?? new Set<string>();
    const outcome = yield* files.write(
      output.path,
      output.text,
      options.concurrentSave === "yield"
        ? { _tag: "IfHoldsOneOf", texts: new Set([snapshot, ...own, ...(ownTexts.get(undefined) ?? [])]) }
        : { _tag: "Overwrite" }
    );

    if (outcome === "changed") {
      return { problems, messages, written, superseded: true } satisfies ExtractResult;
    }

    if (outcome === "written") {
      written.push(output);
      ownTexts.set(snapshot, own.add(output.text));
    }
  }

  return { problems, messages, written, superseded: false } satisfies ExtractResult;
});

/**
 * Check that every catalog is in sync with the sources and compiles: each source message is present and translated,
 * no entry is obsolete, every msgid and msgstr parses, each translation keeps its source's arguments and tags, no two
 * keys share a wire key, the serializer version matches, and each locale's catalog (and the English one) compiles and
 * dry-formats with the app's `formats`, as the loaders will compile it.
 *
 * @param config - The project config.
 * @returns Every problem found, each naming its fix, and the arms the compile does not reach; fails with
 *   `ProjectIoFailed` on I/O the commands do not classify.
 */
export const runCheck = /* @__PURE__ */ Effect.fn("elmera-intl.check")(function* (config: ProjectConfig) {
  const formats = yield* ioEdge("formats", () => loadFormats(config));

  if (formats._tag === "ConfigInvalid") {
    return { problems: [formats.problem], messages: 0, written: [], unreachable: [] } satisfies CommandReport;
  }

  const scanned = yield* scan(config, new Map());

  if (scanned._tag === "Failed") {
    return { problems: scanned.problems, messages: 0, written: [], unreachable: [] } satisfies CommandReport;
  }

  const messages = scanned.messages.length;
  // The sources are analysed once; each locale's PO is read and checked against them in turn, holding one at a time.
  const sources = checkSources(scanned);
  const problems: Array<Problem> = [...sources.problems];
  for (const locale of config.locales) {
    problems.push(...checkLocale(yield* readCatalog(config, locale), sources.compiled));
  }

  if (problems.length > 0) {
    return { problems, messages, written: [], unreachable: [] } satisfies CommandReport;
  }

  // Last, on catalogs every other rule passed: the artifact the loaders build, compiled and dry-formatted with the
  // app's formats, each PO read again as the loaders will read it. The English catalog compiles from the same msgids.
  const files = yield* CatalogFiles;
  const compiled: Array<Problem> = [];
  const unreachable: Array<UnreachableArm> = [];
  for (const locale of [...config.locales, SOURCE_LOCALE]) {
    // `en` compiles from the first locale's PO: every PO holds the same msgids once in sync.
    const path = catalogPath(config, locale === SOURCE_LOCALE ? (config.locales[0] ?? locale) : locale);
    const result = compileLocale(yield* files.readExisting(path), {
      file: relative(config.root, path),
      locale,
      formats: formats.formats,
    });
    compiled.push(...result.problems);
    unreachable.push(...result.unreachable);
  }

  return {
    problems: compiled,
    messages,
    written: [],
    unreachable,
  } satisfies CommandReport;
});
