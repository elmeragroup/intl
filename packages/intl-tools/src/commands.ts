// The CLI's two operations over a project: `extract` writes catalogs, `check` proves them in sync and compilable. Each
// is an effect over its edges (the scan, the formats module, the catalogs' reads and writes); what it decides from what
// it read is pure, in `catalog-plan.ts` and `catalog-check.ts`. `extract`'s sync is `catalog-sync.ts`'s.
import * as Effect from "effect/Effect";
import { relative } from "node:path";

import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { checkLocale, checkSources, compileLocale } from "./catalog-check";
import { CatalogFiles, readCatalog } from "./catalog-files";
import { extractCatalogs } from "./catalog-sync";
import type { UnreachableArm } from "./compile";
import type { Problem } from "./problem";
import { scanProject } from "./project";
import { catalogPath } from "./project-catalogs";
import type { ProjectConfig } from "./project-config";
import { ProjectFormats } from "./project-formats-service";

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

/** A `check` run: its report, and the source files it read, which a host watches so that a repair of one checks again. */
export type CheckRun = {
  readonly report: CommandReport;
  /** Each source file the scan read, as its path joined to the root; none when the config or formats did not load. */
  readonly sources: ReadonlyArray<string>;
};

/**
 * Extract messages and write each locale's PO (`extractCatalogs`). Existing translations, flags and the files are kept
 * when unchanged. Writes nothing when any source or catalog fails.
 *
 * @param config - The project config.
 * @returns The problems (if any), the message count and the files written; fails with `ProjectIoFailed` on I/O the
 *   commands do not classify.
 */
export const runExtract = /* @__PURE__ */ Effect.fn("elmera-intl.extract")(function* (config: ProjectConfig) {
  const { problems, messages, written } = yield* extractCatalogs(config);

  return {
    problems,
    messages,
    written,
    unreachable: [],
  } satisfies CommandReport;
});

/**
 * Check that every catalog is in sync with the sources and compiles: each source message is present and translated,
 * no entry is obsolete, every msgid and msgstr parses, each translation keeps its source's arguments and tags, no two
 * keys share a wire key, the serializer version matches, and each locale's catalog (and the English one) compiles and
 * dry-formats with the app's `formats`, as the loaders will compile it.
 *
 * @param config - The project config.
 * @returns Every problem found, each naming its fix, and the arms the compile does not reach, with the source files
 *   read; fails with `ProjectIoFailed` on I/O the commands do not classify.
 */
export const runCheck = /* @__PURE__ */ Effect.fn("elmera-intl.check")(function* (config: ProjectConfig) {
  const formats = yield* ProjectFormats.use((loader) => loader.load(config));

  if (formats._tag === "ConfigInvalid") {
    return {
      report: { problems: [formats.problem], messages: 0, written: [], unreachable: [] },
      sources: [],
    } satisfies CheckRun;
  }

  const scanned = yield* scanProject(config);
  const { sources: read } = scanned;

  if (scanned._tag === "Failed") {
    return {
      report: { problems: scanned.problems, messages: 0, written: [], unreachable: [] },
      sources: read,
    } satisfies CheckRun;
  }

  const messages = scanned.messages.length;
  // The sources are analysed once; each locale's PO is read and checked against them in turn, holding one at a time.
  const sources = checkSources(scanned);
  const problems: Array<Problem> = [...sources.problems];
  for (const locale of config.locales) {
    problems.push(...checkLocale(yield* readCatalog(config, locale), sources.compiled));
  }

  if (problems.length > 0) {
    return { report: { problems, messages, written: [], unreachable: [] }, sources: read } satisfies CheckRun;
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
    report: { problems: compiled, messages, written: [], unreachable },
    sources: read,
  } satisfies CheckRun;
});
