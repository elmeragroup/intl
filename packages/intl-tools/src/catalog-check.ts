// What `check` finds, decided from what it read: the scanned sources and each locale's PO. Pure: the reads are
// `commands.ts`'s, so `check` judges a project the same way whatever the file system is.
import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";
import type { Formats } from "@elmeragroup/intl/internal/icu";
import { hashKey, keyOf, SERIALIZER_VERSION } from "@elmeragroup/intl/internal/message";

import type { CatalogText } from "./catalog-plan";
import { parseCatalog, RUN_EXTRACT, serializerMismatch } from "./catalog-plan";
import type { CompileProblem, UnreachableArm } from "./compile";
import { compileCatalog } from "./compile";
import { kindConflicts, kindMismatches, messageSlots } from "./message-slots";
import type { PoEntry } from "./po";
import { SERIALIZER_HEADER } from "./po";
import type { Problem } from "./problem";
import type { ProjectMessage } from "./project";

// Weblate's flag for its "unchanged translation" check: the English is correct in this locale as it stands.
const IGNORE_SAME = "ignore-same";

type SlotsOrError = ReturnType<typeof messageSlots>;

// A scanned message with its source compiled once; every locale compares its translations against these slots.
type CompiledSource = { readonly message: ProjectMessage; readonly slots: SlotsOrError };

/** What compiling the catalogs found. */
export type CompiledCatalogs = {
  readonly problems: ReadonlyArray<Problem>;
  /** The arms the compile's branch pass does not reach: information, not problems. */
  readonly unreachable: ReadonlyArray<UnreachableArm>;
};

/**
 * Check that every catalog is in sync with the sources: each source message is present and translated, no entry is
 * obsolete, every msgid and msgstr parses, each translation keeps its source's arguments and tags, no two keys share a
 * wire key, and the serializer version matches.
 *
 * @param scanned - The messages the sources declare, and the include patterns that match no file.
 * @param catalogs - Each locale's PO as read, in the config's order.
 * @returns Every problem found, each naming its fix.
 */
export function checkCatalogs(
  scanned: { readonly messages: ReadonlyArray<ProjectMessage>; readonly unmatched: ReadonlyArray<Problem> },
  catalogs: ReadonlyArray<CatalogText>
): ReadonlyArray<Problem> {
  const sources = scanned.messages.map((message) => ({ message, slots: messageSlots(message.source, "en") }));

  return [
    ...scanned.unmatched,
    ...keyCollisions(scanned.messages),
    ...sources.flatMap(({ message, slots }) => checkSource(message, slots)),
    ...catalogs.flatMap((catalog) => checkLocale(catalog, sources)),
  ];
}

/**
 * Compile and dry-format each locale's catalog, and the English one from the same msgids, with the app's `formats`,
 * as the loaders will compile them. Run on catalogs every rule of `checkCatalogs` passed, each of whose problems names
 * its own fix.
 *
 * @param catalogs - Each locale's PO as read, every one present, in the config's order.
 * @param formats - The app's formats.
 * @returns The problems the compile finds, and the arms it does not reach: information, not problems.
 */
export function compileCatalogs(
  catalogs: ReadonlyArray<CatalogText>,
  formats: Formats | undefined
): CompiledCatalogs {
  const compiled = [...catalogs.map(({ locale }) => locale), SOURCE_LOCALE].map((locale) =>
    compileLocale(catalogs, locale, formats)
  );

  return {
    problems: compiled.flatMap(({ problems }) => problems),
    unreachable: compiled.flatMap(({ unreachable }) => unreachable),
  };
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

function checkLocale(catalog: CatalogText, sources: ReadonlyArray<CompiledSource>): Array<Problem> {
  const po = catalog.shown;
  const read = parseCatalog(catalog);

  if (read._tag === "Problem") {
    return [read.problem];
  }

  if (read.file === undefined) {
    return [
      {
        code: "CatalogMissing",
        message: `${po} does not exist`,
        fix: RUN_EXTRACT,
        file: po,
        locale: catalog.locale,
      },
    ];
  }

  const { file } = read;
  const problems: Array<Problem> = [];
  const at = { file: po, locale: catalog.locale };
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
function compileLocale(
  catalogs: ReadonlyArray<CatalogText>,
  locale: string,
  formats: Formats | undefined
): CompiledCatalogs {
  const catalog =
    locale === SOURCE_LOCALE ? catalogs[0] : catalogs.find((candidate) => candidate.locale === locale);

  // A defect: every locale's PO was read and exists, since a missing one is a CatalogMissing problem and nothing
  // compiles then.
  if (catalog?.text === undefined) {
    throw new Error(`compiled the ${locale} catalog, which was not read`);
  }

  const at = { file: catalog.shown, locale };
  const compiled = compileCatalog(catalog.text, locale, { formats });

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
