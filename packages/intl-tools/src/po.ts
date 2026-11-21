// PO catalog files: the translator-facing source of truth (msgid = English source, msgctxt = context, `#.` = what a
// positional tag stands for, `#:` = files that use the message, without line numbers so edits do not churn them).
import type { Entry as PoParserEntry } from "po-parser";
import POParser from "po-parser";

import { keyOf, SERIALIZER_VERSION } from "@elmeragroup/intl/internal/message";

/** One message in a locale's catalog. */
export type PoEntry = {
  /** The English ICU source (msgid). */
  readonly source: string;
  /** The context (msgctxt), if any. */
  readonly context: string | undefined;
  /** The translation (msgstr); empty when untranslated. */
  readonly translation: string;
  /** Files that use the message, relative to the project root. */
  readonly references: ReadonlyArray<string>;
  /** Extracted comments: what each positional tag stands for. */
  readonly comments: ReadonlyArray<string>;
  /** PO flags (`fuzzy`, ...), from every `#,` line; written on one, `fuzzy` first. */
  readonly flags: ReadonlyArray<string>;
};

/** A parsed PO file. */
export type PoFile = {
  /** Header fields, e.g. `X-Elmera-Serializer`. */
  readonly meta: Readonly<Record<string, string>>;
  readonly entries: ReadonlyArray<PoEntry>;
};

/** A PO file that cannot be parsed. */
export type PoParseError = { readonly _tag: "PoParseError"; readonly reason: string };

/** The header field naming the serializer version a catalog was keyed with. */
export const SERIALIZER_HEADER = "X-Elmera-Serializer";

/**
 * Parse PO text.
 *
 * @param text - The file's content.
 * @returns The catalog, or why it is not a PO file this tool reads.
 */
export function parsePo(text: string): { readonly _tag: "Parsed"; readonly file: PoFile } | PoParseError {
  let parsed: ReturnType<typeof POParser.parse>;
  try {
    parsed = POParser.parse(toParserDialect(text));
  } catch (error) {
    return { _tag: "PoParseError", reason: error instanceof Error ? error.message : String(error) };
  }

  const entries = (parsed.messages ?? []).map((entry): PoEntry => ({
    source: entry.msgid,
    context: entry.msgctxt === "" ? undefined : entry.msgctxt,
    translation: entry.msgstr,
    references: (entry.references ?? []).map((reference) => reference.path),
    comments: entry.extractedComments ?? [],
    flags: entry.flags ?? [],
  }));

  return { _tag: "Parsed", file: { meta: parsed.meta ?? {}, entries } };
}

const FLAG_LINE = "#, ";
const OBSOLETE = "#~";
const FUZZY = "fuzzy";
const KEYWORD = /^msg\w*/u;

// po-parser ends an entry only at a blank line, reads a comment-only block as a broken entry, gives an entry only its
// last `#,` line, and gives an obsolete (`#~`) entry's comments to the next entry. GNU msgcat ends an entry where the
// next starts (`msgctxt`, or `msgid` not after one), gives every comment to the entry it precedes, across blank lines,
// reads every `#,` line, and drops comments after the last entry. Rewrite to po-parser's dialect: comments held until
// their entry starts, one blank line between entries, one `#,` line each, obsolete entries dropped with their comments.
function toParserDialect(text: string): string {
  const lines: Array<string> = [];
  let comments: Array<string> = [];
  let keyword: string | undefined;

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed.startsWith(OBSOLETE)) {
      comments = [];
      continue;
    }

    if (trimmed.startsWith("#")) {
      const flagLine = comments.findIndex((comment) => comment.startsWith(FLAG_LINE));

      if (trimmed.startsWith(FLAG_LINE) && flagLine !== -1) {
        comments[flagLine] = `${comments[flagLine]}, ${trimmed.slice(FLAG_LINE.length)}`;
      } else {
        comments.push(trimmed.startsWith(FLAG_LINE) ? trimmed : line);
      }

      continue;
    }

    if (trimmed === "") {
      continue;
    }

    const next = KEYWORD.exec(trimmed)?.[0];

    if (next === "msgctxt" || (next === "msgid" && keyword !== "msgctxt")) {
      lines.push(...(lines.length === 0 ? [] : [""]), ...comments);
      comments = [];
    }

    keyword = next ?? keyword;
    lines.push(line);
  }

  return lines.join("\n");
}

// GNU msgcat's form: one `#,` line, `fuzzy` first. It drops flags it does not know; code-point order keeps ours stable.
function canonicalFlags(flags: ReadonlyArray<string>): Array<string> {
  return [...new Set(flags)].toSorted(
    (a, b) => Number(b === FUZZY) - Number(a === FUZZY) || compareText(a, b)
  );
}

/**
 * Write a locale's catalog. Entries are sorted by source, then context, so output is stable across runs.
 *
 * @param locale - The catalog's locale, written to the `Language` header.
 * @param entries - The entries to write.
 * @returns PO text ending in a newline.
 */
export function formatPo(locale: string, entries: ReadonlyArray<PoEntry>): string {
  const messages = entries.toSorted(compareEntries).map((entry) => {
    const message: PoParserEntry = {
      msgid: entry.source,
      msgstr: entry.translation,
      references: entry.references.map((path) => ({ path })),
      extractedComments: [...entry.comments],
      flags: canonicalFlags(entry.flags),
    };

    if (entry.context !== undefined) {
      message.msgctxt = entry.context;
    }

    return message;
  });
  const meta = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Transfer-Encoding": "8bit",
    Language: locale,
    [SERIALIZER_HEADER]: SERIALIZER_VERSION,
  };

  return POParser.serialize({ meta, messages });
}

/** A message the sources declare, as a catalog entry needs it. */
export type SourceMessage = Pick<PoEntry, "source" | "context" | "references" | "comments">;

/**
 * How a merge treats catalog entries no source declares: `extract` drops them so a commit carries a clean catalog;
 * `extract --watch` keeps them, so a file mid-edit or a branch switch never loses a translation.
 */
export type UnusedEntries = "drop" | "keep";

/**
 * Merge the sources' messages into a catalog's entries. Translations and flags are always kept; under `keep`,
 * references only grow and unused entries stay as they are.
 *
 * @param existing - The catalog's current entries.
 * @param messages - The messages the sources declare.
 * @param unused - What happens to entries no message matches.
 * @returns The merged entries, unordered (`formatPo` sorts).
 */
export function mergeEntries(
  existing: ReadonlyArray<PoEntry>,
  messages: ReadonlyArray<SourceMessage>,
  unused: UnusedEntries
): Array<PoEntry> {
  const previous = new Map(existing.map((entry) => [keyOf(entry.source, entry.context), entry]));
  const merged = new Map(
    messages.map((message) => {
      const key = keyOf(message.source, message.context);
      const kept = previous.get(key);
      const references =
        unused === "keep" && kept !== undefined
          ? [...new Set([...kept.references, ...message.references])].toSorted(compareText)
          : message.references;

      return [
        key,
        {
          source: message.source,
          context: message.context,
          translation: kept?.translation ?? "",
          references,
          comments: message.comments,
          flags: kept?.flags ?? [],
        },
      ] as const;
    })
  );

  if (unused === "keep") {
    for (const [key, entry] of previous) {
      if (!merged.has(key)) {
        merged.set(key, entry);
      }
    }
  }

  return [...merged.values()];
}

/**
 * Code-point order: stable across ICU versions, unlike localeCompare.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns Negative when `a` sorts first, positive when `b` does, 0 when equal.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(a: PoEntry, b: PoEntry): number {
  return compareText(a.source, b.source) || compareText(a.context ?? "", b.context ?? "");
}
