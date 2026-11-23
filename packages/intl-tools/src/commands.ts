// The CLI's two operations over a project: `extract` writes catalogs, `check` proves them in sync and compilable. Each
// is an effect over its edges (the scan, the formats module, the catalogs' reads and writes); what it decides from what
// it read is pure, in `catalog-plan.ts` and `catalog-check.ts`.
import * as Effect from "effect/Effect";
import { relative } from "node:path";

import { checkCatalogs, compileCatalogs } from "./catalog-check";
import type { CatalogStorage } from "./catalog-files";
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

// Each locale's PO as it is now, in the config's order.
const readCatalogs = /* @__PURE__ */ Effect.fnUntraced(function* (config: ProjectConfig) {
  const files = yield* CatalogFiles;

  const catalogs: Array<CatalogText> = [];
  for (const locale of config.locales) {
    const path = catalogPath(config, locale);
    catalogs.push({ locale, path, shown: relative(config.root, path), text: yield* files.read(path) });
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

  return mergeCatalogs(yield* readCatalogs(config), scanned.messages, options.unused);
});

// What one catalog's write did.
type WriteOutcome = "written" | "unchanged" | "superseded";

// One catalog's read, decision and write, in a section an interruption cannot split: under `yield`, the target is read
// again right before its write, so a save that landed since the plan read it (while an earlier catalog was written)
// is never written over.
const writeCatalog = /* @__PURE__ */ Effect.fn("elmera-intl.writeCatalog")(function* (
  files: CatalogStorage,
  plan: CatalogPlan,
  output: WrittenCatalog,
  options: ExtractOptions
) {
  const current = yield* files.read(output.path);

  if (options.concurrentSave === "yield" && current !== plan.read.get(output.path)) {
    return "superseded" satisfies WriteOutcome;
  }

  // An unchanged catalog is not written: its mtime stays, so no build or editor sees a change.
  if (current === output.text) {
    return "unchanged" satisfies WriteOutcome;
  }

  yield* files.write(output.path, output.text);

  return "written" satisfies WriteOutcome;
}, Effect.uninterruptible);

/**
 * Write a plan's catalogs, skipping each whose text is unchanged. Writes nothing when the plan has problems. Under
 * `yield`, writes nothing when a PO changed after the plan read it, and stops before a target that changed since (one
 * saved while an earlier catalog was written).
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

  if (options.concurrentSave === "yield") {
    for (const [path, text] of plan.read) {
      if ((yield* files.read(path)) !== text) {
        return { problems, messages, written: [], superseded: true } satisfies ExtractResult;
      }
    }
  }

  const written: Array<WrittenCatalog> = [];
  for (const output of plan.outputs) {
    const outcome = yield* writeCatalog(files, plan, output, options);

    if (outcome === "superseded") {
      return { problems, messages, written, superseded: true } satisfies ExtractResult;
    }

    if (outcome === "written") {
      written.push(output);
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
  const catalogs = yield* readCatalogs(config);
  const problems = checkCatalogs(scanned, catalogs);

  if (problems.length > 0) {
    return { problems, messages, written: [], unreachable: [] } satisfies CommandReport;
  }

  // Last, on catalogs every other rule passed: the artifact the loaders build, compiled and dry-formatted with the
  // app's formats.
  const compiled = compileCatalogs(catalogs, formats.formats);

  return {
    problems: compiled.problems,
    messages,
    written: [],
    unreachable: compiled.unreachable,
  } satisfies CommandReport;
});
