// The CLI's two operations over a project: `extract` writes catalogs, `check` proves them in sync and compilable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";
import type { Formats } from "@elmeragroup/intl/internal/icu";
import { hashKey, keyOf, SERIALIZER_VERSION } from "@elmeragroup/intl/internal/message";

import type { CompileProblem, UnreachableArm } from "./compile";
import { compileCatalog } from "./compile";
import { kindConflicts, kindMismatches, messageSlots } from "./message-slots";
import type { PoEntry, PoFile, UnusedEntries } from "./po";
import { formatPo, mergeEntries, parsePo, SERIALIZER_HEADER } from "./po";
import type { Problem } from "./problem";
import type { ParseCache, ProjectMessage } from "./project";
import { catalogPath, loadFormats, scanProject } from "./project";
import type { ProjectConfig } from "./project-config";

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

const RUN_EXTRACT = "run `elmera-intl extract`";

// Weblate's flag for its "unchanged translation" check: the English is correct in this locale as it stands.
const IGNORE_SAME = "ignore-same";

type SlotsOrError = ReturnType<typeof messageSlots>;

// A scanned message with its source compiled once; every locale compares its translations against these slots.
type CompiledSource = { readonly message: ProjectMessage; readonly slots: SlotsOrError };

/** How `runExtract` merges and scans. */
export type ExtractOptions = {
  /** Whether entries no source uses any more are dropped (`extract`) or kept (`extract --watch`). */
  readonly unused: UnusedEntries;
  /** Parse results to reuse across runs; a one-shot run starts empty. */
  readonly cache: ParseCache;
  /**
   * What a PO saved between its read and the write does: `overwrite` writes over it (`extract`), `yield` writes
   * nothing so the next sync merges the save (`extract --watch`, where a translator saves while a sync runs).
   */
  readonly concurrentSave: "overwrite" | "yield";
};

/** A catalog file with the exact text written to it. */
export type WrittenCatalog = { readonly path: string; readonly text: string };

/** What `planCatalogs` read and would write. */
export type CatalogPlan = {
  readonly problems: ReadonlyArray<Problem>;
  readonly messages: number;
  /** Each PO's text as read (undefined: absent): the input the outputs were merged from. */
  readonly read: ReadonlyMap<string, string | undefined>;
  readonly outputs: ReadonlyArray<WrittenCatalog>;
};

/** What `extractCatalogs` did: `runExtract`'s report, with each written file's text. */
export type ExtractResult = Omit<CommandReport, "written" | "unreachable"> & {
  readonly written: ReadonlyArray<WrittenCatalog>;
  /** A PO changed after it was read, so (under `yield`) nothing was written. */
  readonly superseded: boolean;
};

/**
 * Extract messages and write each locale's PO. Existing translations, flags and the files are kept when unchanged.
 * Writes nothing when any source or catalog fails.
 *
 * @param config - The project config.
 * @param options - Merge mode and parse cache; by default a full sync that drops unused entries.
 * @returns The problems (if any), the message count and the files written.
 */
export function runExtract(config: ProjectConfig, options?: ExtractOptions): CommandReport {
  const { problems, messages, written } = extractCatalogs(
    config,
    options ?? { unused: "drop", cache: new Map(), concurrentSave: "overwrite" }
  );

  return { problems, messages, written: written.map(({ path }) => path), unreachable: [] };
}

/**
 * `runExtract`, returning the text of each file it wrote: a watcher that reads a file back after the write could
 * read an edit saved since.
 *
 * @param config - The project config.
 * @param options - Merge mode, parse cache and what a concurrent save does.
 * @returns The problems (if any), the message count and each file written with its text.
 */
export function extractCatalogs(config: ProjectConfig, options: ExtractOptions): ExtractResult {
  return writeCatalogs(planCatalogs(config, options), options);
}

/**
 * Scan the sources, read each PO and merge: every catalog `writeCatalogs` would write, and the POs it read.
 *
 * @param config - The project config.
 * @param options - Merge mode and parse cache.
 * @returns The problems (if any), the message count, the POs read and the outputs.
 */
export function planCatalogs(config: ProjectConfig, options: ExtractOptions): CatalogPlan {
  const scanned = scanProject(config, options.cache);

  if (scanned._tag === "Failed") {
    return { problems: scanned.problems, messages: 0, read: new Map(), outputs: [] };
  }

  if (scanned.unmatched.length > 0) {
    return { problems: scanned.unmatched, messages: scanned.messages.length, read: new Map(), outputs: [] };
  }

  const read = new Map<string, string | undefined>();
  const outputs: Array<WrittenCatalog> = [];
  const problems: Array<Problem> = [];
  for (const locale of config.locales) {
    const path = catalogPath(config, locale);
    const po = relative(config.root, path);
    const existing = readPo(path, po, locale);

    if (existing._tag === "Problem") {
      problems.push(existing.problem);
      continue;
    }

    read.set(path, existing.text);
    // Rewriting a catalog keyed by another serializer would drop every translation whose key changed.
    const version = existing.file?.meta[SERIALIZER_HEADER];

    if (version !== undefined && version !== SERIALIZER_VERSION) {
      problems.push(serializerMismatch(version, { file: po, locale }));
      continue;
    }

    const entries = mergeEntries(existing.file?.entries ?? [], scanned.messages, options.unused);
    outputs.push({ path, text: formatPo(locale, entries) });
  }

  return problems.length > 0
    ? { problems, messages: scanned.messages.length, read, outputs: [] }
    : { problems, messages: scanned.messages.length, read, outputs };
}

/**
 * Write a plan's catalogs, skipping each whose text is unchanged. Writes nothing when the plan has problems, or,
 * under `yield`, when a PO changed after the plan read it.
 *
 * @param plan - What `planCatalogs` read and would write.
 * @param options - What a concurrent save does.
 * @returns The plan's problems and message count, and each file written with its text.
 */
export function writeCatalogs(plan: CatalogPlan, options: ExtractOptions): ExtractResult {
  const { problems, messages } = plan;

  if (problems.length > 0) {
    return { problems, messages, written: [], superseded: false };
  }

  if (options.concurrentSave === "yield" && [...plan.read].some(([path, text]) => textAt(path) !== text)) {
    return { problems, messages, written: [], superseded: true };
  }

  const written = plan.outputs.filter(({ path, text }) => {
    if (textAt(path) === text) {
      return false;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    return true;
  });

  return { problems, messages, written, superseded: false };
}

function textAt(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Check that every catalog is in sync with the sources and compiles: each source message is present and translated,
 * no entry is obsolete, every msgid and msgstr parses, each translation keeps its source's arguments and tags, no two
 * keys share a wire key, the serializer version matches, and each locale's catalog (and the English one) compiles and
 * dry-formats with the app's `formats`, as the loaders will compile it.
 *
 * @param config - The project config.
 * @returns Every problem found, each naming its fix, and the arms the compile does not reach.
 */
export function runCheck(config: ProjectConfig): CommandReport {
  const formats = loadFormats(config);

  if (formats._tag === "ConfigInvalid") {
    return { problems: [formats.problem], messages: 0, written: [], unreachable: [] };
  }

  const scanned = scanProject(config);

  if (scanned._tag === "Failed") {
    return { problems: scanned.problems, messages: 0, written: [], unreachable: [] };
  }

  const sources = scanned.messages.map((message) => ({ message, slots: messageSlots(message.source, "en") }));
  const problems: Array<Problem> = [
    ...scanned.unmatched,
    ...keyCollisions(scanned.messages),
    ...sources.flatMap(({ message, slots }) => checkSource(message, slots)),
  ];
  for (const locale of config.locales) {
    problems.push(...checkLocale(config, locale, sources));
  }

  // Last, on catalogs every other rule passed (each problem above names its own fix): the artifact the loaders build,
  // compiled and dry-formatted with the app's formats. The English catalog compiles from the same msgids.
  const unreachable: Array<UnreachableArm> = [];

  if (problems.length === 0) {
    for (const locale of [...config.locales, SOURCE_LOCALE]) {
      const compiled = compileLocale(config, locale, formats.formats);
      problems.push(...compiled.problems);
      unreachable.push(...compiled.unreachable);
    }
  }

  return { problems, messages: scanned.messages.length, written: [], unreachable };
}

// Two source keys with one wire key would render each other's text; the compiler fails on it too, but only for keys a
// PO holds, and a message must collide before it is extracted to be fixed before it ships.
function keyCollisions(messages: ReadonlyArray<ProjectMessage>): Array<Problem> {
  const owners = new Map<string, ProjectMessage>();

  return messages.flatMap((message) => {
    const hash = hashKey(message.key);
    const owner = owners.get(hash);

    if (owner === undefined) {
      owners.set(hash, message);

      return [];
    }

    return [
      {
        code: "KeyCollision",
        message: `wire key ${hash} is also ${JSON.stringify(owner.key)}'s (${owner.references[0] ?? "?"})`,
        fix: "give one of the two messages a context (or reword it)",
        file: message.references[0],
        key: message.key,
      },
    ];
  });
}

function checkSource(message: ProjectMessage, slots: SlotsOrError): Array<Problem> {
  const at = { file: message.references[0], key: message.key };

  if (slots._tag === "IcuSyntaxError") {
    return [
      {
        code: "SourceInvalid",
        message: `source does not compile as ICU: ${slots.reason}`,
        fix: "fix the message in the source file",
        ...at,
      },
    ];
  }

  return kindConflicts(slots.slots).map(({ name, kinds }) => ({
    code: "ArgumentKindConflict",
    message: `source uses {${name}} as ${kinds.join(" and ")}, and no one value renders in every use`,
    fix: `format {${name}} as one kind in every branch (e.g. {${name}, number} everywhere), or pass a separate argument for the text`,
    ...at,
  }));
}

function checkLocale(
  config: ProjectConfig,
  locale: string,
  sources: ReadonlyArray<CompiledSource>
): Array<Problem> {
  const path = catalogPath(config, locale);
  const po = relative(config.root, path);
  const read = readPo(path, po, locale);

  if (read._tag === "Problem") {
    return [read.problem];
  }

  if (read.file === undefined) {
    return [{ code: "CatalogMissing", message: `${po} does not exist`, fix: RUN_EXTRACT, file: po, locale }];
  }

  const { file } = read;
  const problems: Array<Problem> = [];
  const at = { file: po, locale };
  const version = file.meta[SERIALIZER_HEADER];

  if (version !== SERIALIZER_VERSION) {
    problems.push(
      version === undefined
        ? {
            code: "SerializerMismatch",
            message: `catalog has no ${SERIALIZER_HEADER} header`,
            fix: RUN_EXTRACT,
            ...at,
          }
        : serializerMismatch(version, at)
    );
  }

  const entries = new Map(file.entries.map((entry) => [keyOf(entry.source, entry.context), entry]));
  for (const { message } of sources) {
    if (!entries.has(message.key)) {
      problems.push({
        code: "CatalogOutOfSync",
        message: "message missing from the catalog",
        fix: RUN_EXTRACT,
        ...at,
        key: message.key,
      });
    }
  }

  const sourceByKey = new Map(sources.map((source) => [source.message.key, source.slots] as const));
  for (const [key, entry] of entries) {
    const source = sourceByKey.get(key);

    if (source === undefined) {
      problems.push({
        code: "CatalogOutOfSync",
        message: "catalog entry no source uses",
        fix: RUN_EXTRACT,
        ...at,
        key,
      });
      continue;
    }

    problems.push(...checkTranslation(entry, key, source, at));
  }

  return problems;
}

// `en` compiles from the first locale's PO: every PO holds the same msgids once in sync.
function compileLocale(config: ProjectConfig, locale: string, formats: Formats | undefined) {
  const path = catalogPath(config, locale === SOURCE_LOCALE ? (config.locales[0] ?? locale) : locale);
  const at = { file: relative(config.root, path), locale };
  const compiled = compileCatalog(readFileSync(path, "utf8"), locale, { formats });

  if (compiled._tag === "Compiled") {
    return { problems: [], unreachable: compiled.unreachable };
  }

  return { problems: compiled.problems.map((problem) => compileProblem(problem, at)), unreachable: [] };
}

function compileProblem(
  problem: CompileProblem,
  at: { readonly file: string; readonly locale: string }
): Problem {
  const where = { ...at, key: problem.key };
  const fix = problem.english
    ? "fix the message in the source file"
    : `fix the msgstr in ${at.file} (an option Intl rejects: a currency code, a time zone, a skeleton)`;

  switch (problem.pass) {
    case "node":
    case "branch":
      return {
        code: problem.english ? "SourceUnformattable" : "TranslationUnformattable",
        message: `throws when formatted: ${problem.reason}`,
        fix,
        ...where,
      };
    case "probe":
      return {
        code: "ArmProbeMismatch",
        message: problem.reason,
        fix: "report it: the dry-format's sample selected another arm than the runtime (an @elmeragroup/intl defect)",
        ...where,
      };
    case "codec":
      return {
        code: "CatalogCodecMismatch",
        message: problem.reason,
        fix: "report it: the compiled catalog would not decode to this message (an @elmeragroup/intl defect)",
        ...where,
      };
    case "po":
    case "parse":
    case "collision":
      return { code: "CatalogInvalid", message: problem.reason, fix, ...where };
  }
}

function checkTranslation(
  entry: PoEntry,
  key: string,
  source: SlotsOrError,
  at: { readonly file: string; readonly locale: string }
): Array<Problem> {
  if (entry.translation === "") {
    return [
      {
        code: "TranslationMissing",
        message: "untranslated",
        fix: `translate it in ${at.file}, then ${RUN_EXTRACT}`,
        ...at,
        key,
      },
    ];
  }

  const ignoresSame = entry.flags.includes(IGNORE_SAME);

  // Exact: whitespace is part of the rendered text, and no catalog holds a near-identical pair.
  if (entry.translation === entry.source) {
    return ignoresSame
      ? []
      : [
          {
            code: "TranslationIdenticalToSource",
            message: "translation is the English source",
            fix: `translate it in ${at.file}, or flag the entry \`#, ${IGNORE_SAME}\` when the English is correct in ${at.locale} (a loanword, a name, placeholders only)`,
            ...at,
            key,
          },
        ];
  }

  // Like a lint disable that suppresses nothing: a stale flag would let a later English msgstr pass.
  const problems: Array<Problem> = ignoresSame
    ? [
        {
          code: "IgnoreSameUnused",
          message: `flagged ${IGNORE_SAME}, and the translation differs from the source`,
          fix: `remove \`${IGNORE_SAME}\` from the entry's \`#,\` flags in ${at.file}`,
          ...at,
          key,
        },
      ]
    : [];

  const translated = messageSlots(entry.translation, at.locale);

  if (translated._tag === "IcuSyntaxError") {
    return [
      ...problems,
      {
        code: "TranslationInvalid",
        message: `translation does not compile as ICU: ${translated.reason}`,
        fix: `fix the msgstr in ${at.file}`,
        ...at,
        key,
      },
    ];
  }

  if (source._tag === "IcuSyntaxError") {
    return problems;
  }

  if (source.slots.args.join(",") !== translated.slots.args.join(",")) {
    problems.push({
      code: "PlaceholderMismatch",
      message: `translation uses {${translated.slots.args.join("}, {")}}, the source {${source.slots.args.join("}, {")}}`,
      fix: `use exactly the source's placeholders in the msgstr in ${at.file}`,
      ...at,
      key,
    });
  }

  // A source conflict is reported once, on the source, and an argument the source lacks as a PlaceholderMismatch.
  const sourceConflicts = new Set(kindConflicts(source.slots).map(({ name }) => name));
  const conflicts = kindConflicts(translated.slots).flatMap(({ name, kinds }) => {
    const expected = source.slots.kinds.get(name);

    return expected === undefined || sourceConflicts.has(name)
      ? []
      : [{ name, kinds, expected: [...expected] }];
  });
  for (const { name, kinds, expected } of conflicts) {
    problems.push({
      code: "ArgumentKindConflict",
      message: `translation uses {${name}} as ${kinds.join(" and ")}, and no one value renders in every use`,
      fix: `format {${name}} as ${expected.join(" or ")} in every branch of the msgstr in ${at.file}`,
      ...at,
      key,
    });
  }

  // A conflict implies a mismatch whenever the source is consistent; report it once, as the conflict.
  const conflicted = new Set(conflicts.map(({ name }) => name));
  for (const { name, used, expected } of kindMismatches(source.slots, translated.slots)) {
    if (conflicted.has(name)) {
      continue;
    }

    problems.push({
      code: "ArgumentKindMismatch",
      message: `translation uses {${name}} as ${used}, the source as ${expected.join(" or ")}`,
      fix: `format {${name}} as ${expected.join(" or ")} in the msgstr in ${at.file} (plain {x} or select for text; number, plural or selectordinal for a number; date or time for a date)`,
      ...at,
      key,
    });
  }

  if (source.slots.tags.join(",") !== translated.slots.tags.join(",")) {
    problems.push({
      code: "TagMismatch",
      message: `translation has tags <${translated.slots.tags.join(">, <")}>, the source <${source.slots.tags.join(">, <")}>`,
      fix: `keep each of the source's tags exactly once in the msgstr in ${at.file} (order may change)`,
      ...at,
      key,
    });
  }

  return problems;
}

function serializerMismatch(
  version: string,
  at: { readonly file: string; readonly locale: string }
): Problem {
  return {
    code: "SerializerMismatch",
    message: `catalog keyed by serializer ${version}, this package serializes as ${SERIALIZER_VERSION}; extract refuses to rewrite it`,
    fix: `move each msgstr to its re-keyed msgid by hand, set ${SERIALIZER_HEADER} to ${SERIALIZER_VERSION} in ${at.file}, then ${RUN_EXTRACT}`,
    ...at,
  };
}

type ReadPo =
  | { readonly _tag: "Read"; readonly file: PoFile | undefined; readonly text: string | undefined }
  | { readonly _tag: "Problem"; readonly problem: Problem };

function readPo(path: string, shown: string, locale: string): ReadPo {
  const text = textAt(path);

  if (text === undefined) {
    return { _tag: "Read", file: undefined, text };
  }

  const parsed = parsePo(text);

  if (parsed._tag === "PoParseError") {
    return {
      _tag: "Problem",
      problem: {
        code: "CatalogUnreadable",
        message: parsed.reason,
        fix: "keep the PO to msgctxt/msgid/msgstr with #. #: #, comments: translator comments (# ), #| and msgid_plural are not read",
        file: shown,
        locale,
      },
    };
  }

  return { _tag: "Read", file: parsed.file, text };
}
