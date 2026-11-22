// The PO text format, as one codec: `PoText` decodes PO text to a `PoDocument` and encodes one back. It reads what
// GNU msgcat reads where the tools rely on it (where an entry ends, which entry a comment belongs to, `#,` lines and
// obsolete entries), and otherwise what the PO reader and writer it was ported from (NOTICE) do, call for call: their
// quirks are part of the format our catalogs were written in, and test/po-conformance holds both.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

import type { PoMessage, PoReference } from "./po-document.ts";
import { PoDocument } from "./po-document.ts";

type Document = typeof PoDocument.Type;
type Message = typeof PoMessage.Type;
type Reference = typeof PoReference.Type;

type Keyword = "msgctxt" | "msgid" | "msgstr";

// A message while its lines are read, its strings under the keywords that set them (`finish` names them): each is
// set once its keyword's line is read.
type Draft = {
  -readonly [K in Keyword]?: string;
} & {
  references: Array<Reference>;
  extractedComments: Array<string>;
  flags: Array<string>;
};

const QUOTE = '"';
const OBSOLETE = "#~";
const COMMENT = "#";
const KEYWORD = /^msg\w*/u;
// Each character PO escapes, and the letter it escapes to.
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\"],
  ['"', '"'],
  ["\n", "n"],
  ["\r", "r"],
  ["\t", "t"],
]);
// The letter after a backslash, and the character it stands for: ESCAPES reversed.
const UNESCAPES: ReadonlyMap<string, string> = new Map(
  /* @__PURE__ */ Array.from(ESCAPES, ([char, code]): [string, string] => [code, char])
);
// Any character ESCAPES holds: a string without one is written as it is.
const ESCAPABLE = /[\\"\n\r\t]/u;

function escape(value: string): string {
  if (!ESCAPABLE.test(value)) {
    return value;
  }

  let result = "";

  for (const char of value) {
    const code = ESCAPES.get(char);
    result += code === undefined ? char : `\\${code}`;
  }

  return result;
}

// A backslash before a letter PO does not escape stays as written.
function unescape(value: string): string {
  if (!value.includes("\\")) {
    return value;
  }

  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const unescaped =
      char === "\\" && index + 1 < value.length ? UNESCAPES.get(value.charAt(index + 1)) : undefined;

    if (unescaped === undefined) {
      result += char;
    } else {
      result += unescaped;
      index += 1;
    }
  }

  return result;
}

// The text after a string's opening quote, without its closing quote when it has one. A lone `"` reads as itself: the
// ported reader's substring(1, 0) swaps its bounds.
function unquote(trimmed: string): string {
  if (trimmed === QUOTE) {
    return trimmed;
  }

  return trimmed.endsWith(QUOTE) ? trimmed.slice(QUOTE.length, -QUOTE.length) : trimmed.slice(QUOTE.length);
}

// The text between a string's quotes. The failure names the text as given.
function quoted(text: string): Result.Result<string, string> {
  const trimmed = text.trim();

  return trimmed.startsWith(QUOTE) && trimmed.endsWith(QUOTE)
    ? Result.succeed(unquote(trimmed))
    : Result.fail(`Incomplete quoted string:\n> ${text}`);
}

const hasPrefix = (line: string, prefix: string): boolean => line.startsWith(`${prefix} `);

type PendingComment = { readonly text: string; readonly line: number };

// Why reading stopped, and the 1-based line where it did.
const failureAt = (line: number, reason: string): string => `line ${line}: ${reason}`;

// The reader, one trimmed line at a time, over GNU msgcat's entries: an entry starts at `msgctxt`, or at `msgid` not
// after one, blank line or not; a comment belongs to the entry it precedes, across blank lines; every `#,` line of an
// entry is read; an obsolete (`#~`) entry is dropped with the comments before it; comments after the last entry are
// dropped. The first message whose msgid and msgstr are both empty is the header: its comments are dropped, and the
// quoted lines that follow it, up to the next entry, are its fields, one per line. Each method returns the failure that
// stops reading, if any.
class PoReader {
  readonly messages: Array<Message> = [];
  readonly header: Record<string, string> = {};
  private inHeader = false;
  // The entry being read: undefined before the first and while the header's fields are read.
  private draft: Draft | undefined;
  // The keyword whose string a quoted line continues.
  private lastKeyword: Keyword | undefined;
  // The last `msg…` word that opened a line, which decides whether a `msgid` starts an entry.
  private lastWord: string | undefined;
  // The comments since the last entry started, held for the next one.
  private pending: Array<PendingComment> = [];

  read(text: string, line: number): string | undefined {
    if (text.startsWith(OBSOLETE)) {
      this.pending = [];

      return undefined;
    }

    if (text.startsWith(COMMENT)) {
      this.pending.push({ text, line });

      return undefined;
    }

    if (text === "") {
      return undefined;
    }

    const word = KEYWORD.exec(text)?.[0];
    const startsEntry = word === "msgctxt" || (word === "msgid" && this.lastWord !== "msgctxt");
    this.lastWord = word ?? this.lastWord;
    const started = startsEntry ? this.startEntry(line) : undefined;

    if (started !== undefined) {
      return started;
    }

    const reason = this.inHeader ? this.readField(text) : this.readEntryLine(text);

    return reason === undefined ? undefined : failureAt(line, reason);
  }

  // Ends the entry being read, which is complete only with both its msgid and msgstr.
  endEntry(line: number): string | undefined {
    const { draft } = this;
    this.draft = undefined;
    this.lastKeyword = undefined;

    if (draft === undefined) {
      return undefined;
    }

    if (draft.msgid === undefined || draft.msgstr === undefined) {
      return failureAt(line, "Incomplete message entry: both msgid and msgstr are required");
    }

    const message: Message = {
      id: draft.msgid,
      translation: draft.msgstr,
      references: draft.references,
      extractedComments: draft.extractedComments,
      flags: draft.flags,
    };
    this.messages.push(draft.msgctxt === undefined ? message : { ...message, context: draft.msgctxt });

    return undefined;
  }

  // Ends the entry before, then gives the new one the comments held for it, stopping at the first that fails.
  private startEntry(line: number): string | undefined {
    const ended = this.endEntry(line);

    if (ended !== undefined) {
      return ended;
    }

    this.inHeader = false;

    for (const comment of this.pending) {
      const reason = this.applyComment(comment.text);

      if (reason !== undefined) {
        return failureAt(comment.line, reason);
      }
    }

    this.pending = [];

    return undefined;
  }

  // A comment of the entry: `#,` flags, `#:` references and `#.` extracted comments are read, translator (`# `) and
  // previous-string (`#| `) comments fail, and any other comment is dropped.
  private applyComment(text: string): string | undefined {
    if (hasPrefix(text, "#")) {
      return `Translator comments (#) are not supported, use inline descriptions instead:\n> ${text}`;
    }

    if (hasPrefix(text, "#|")) {
      return `Previous string key comments (#|) are not supported:\n> ${text}`;
    }

    // Every `#,` line of an entry adds its flags, in order.
    if (hasPrefix(text, "#,")) {
      const { flags } = this.draftOf();

      for (const flag of text.slice(2).split(",")) {
        if (flag.trim() !== "") {
          flags.push(flag.trim());
        }
      }
    } else if (hasPrefix(text, "#:")) {
      const [path = "", lineText] = text.slice(2).trim().split(":");
      // oxlint-disable-next-line radix -- conformance: the ported reader parses a line with parseInt's own radix, so a catalog it wrote reads back the same ("0x1A" is line 26).
      const parsedLine = lineText === undefined ? Number.NaN : Number.parseInt(lineText);
      // A line of 0 is no line, as the ported reader reads it.
      const reference: Reference =
        Number.isNaN(parsedLine) || parsedLine === 0 ? { path } : { path, line: parsedLine };
      this.draftOf().references.push(reference);
    } else if (hasPrefix(text, "#.")) {
      this.draftOf().extractedComments.push(text.slice(2).trim());
    }

    return undefined;
  }

  // A header field: `"Key: value\n"`. It may lack its closing quote; the value is trimmed, its newline with it.
  private readField(text: string): string | undefined {
    if (!text.startsWith(QUOTE)) {
      return `Encountered unexpected non-quoted metadata line:\n> ${text}`;
    }

    const fieldText = unescape(unquote(text));
    const separator = fieldText.indexOf(":");

    if (separator > 0) {
      this.header[fieldText.slice(0, separator).trim()] = fieldText.slice(separator + 1).trim();
    }

    return undefined;
  }

  // A line of the entry that is not a comment: a keyword's string, or a quoted line continuing the last one. Any other
  // line is dropped.
  private readEntryLine(text: string): string | undefined {
    if (hasPrefix(text, "msgid_plural")) {
      return `Plural forms (msgid_plural) are not supported, use ICU pluralization instead:\n> ${text}`;
    }

    for (const keyword of ["msgctxt", "msgid", "msgstr"] as const) {
      if (hasPrefix(text, keyword)) {
        return this.readKeyword(keyword, text.slice(keyword.length + 1));
      }
    }

    return text.startsWith(QUOTE) ? this.continueString(text) : undefined;
  }

  private draftOf(): Draft {
    this.draft ??= { references: [], extractedComments: [], flags: [] };

    return this.draft;
  }

  private readKeyword(keyword: Keyword, rest: string): string | undefined {
    const value = quoted(rest);

    if (Result.isFailure(value)) {
      return value.failure;
    }

    const draft = this.draftOf();
    draft[keyword] = unescape(value.success);
    this.lastKeyword = keyword;

    // The header: the first message with an empty msgid and msgstr. Its comments are dropped.
    if (this.messages.length === 0 && draft.msgid === "" && draft.msgstr === "") {
      this.inHeader = true;
      this.draft = undefined;
      this.lastKeyword = undefined;
    }

    return undefined;
  }

  private continueString(text: string): string | undefined {
    const { draft, lastKeyword } = this;
    const current = lastKeyword === undefined ? undefined : draft?.[lastKeyword];

    if (draft === undefined || lastKeyword === undefined || current === undefined) {
      return `Encountered unexpected quoted line:\n> ${text}`;
    }

    const value = quoted(text);

    if (Result.isFailure(value)) {
      return value.failure;
    }

    draft[lastKeyword] = current + unescape(value.success);

    return undefined;
  }
}

// The document a PO text holds, or the reason and line where reading stopped.
function readPoText(text: string): Result.Result<Document, string> {
  const reader = new PoReader();
  const lines = text.split(/\r?\n/u);

  for (const [index, raw] of lines.entries()) {
    const failure = reader.read(raw.trim(), index + 1);

    if (failure !== undefined) {
      return Result.fail(failure);
    }
  }

  const failure = reader.endEntry(lines.length);

  if (failure !== undefined) {
    return Result.fail(failure);
  }

  const document: Document = { messages: reader.messages };

  return Result.succeed(
    Object.keys(reader.header).length === 0 ? document : { ...document, header: reader.header }
  );
}

// The ported writer: a header (when the document has one) then each message, every block ending in a blank line.
function writePoText(document: Document): string {
  const lines: Array<string> = [];

  if (document.header !== undefined) {
    lines.push('msgid ""', 'msgstr ""');

    for (const [key, value] of Object.entries(document.header)) {
      lines.push(`"${key}: ${escape(value)}\\n"`);
    }

    lines.push("");
  }

  // One push per line: a message may have more comments or references than a call takes arguments.
  for (const message of document.messages) {
    for (const comment of message.extractedComments) {
      lines.push(`#. ${comment}`);
    }

    for (const reference of message.references) {
      lines.push(
        reference.line === undefined || reference.line === 0
          ? `#: ${reference.path}`
          : `#: ${reference.path}:${reference.line}`
      );
    }

    if (message.flags.length > 0) {
      lines.push(`#, ${message.flags.join(", ")}`);
    }

    if (message.context !== undefined && message.context !== "") {
      lines.push(`msgctxt "${escape(message.context)}"`);
    }

    lines.push(`msgid "${escape(message.id)}"`, `msgstr "${escape(message.translation)}"`, "");
  }

  return lines.join("\n");
}

/**
 * PO text as a `PoDocument`: decoding reads the text, failing with the reason and line where reading stopped; encoding
 * writes the document. Every value is written on one line, so a decode of an encode returns the document.
 */
export const PoText = /* @__PURE__ */ Schema.String.pipe(
  /* @__PURE__ */ Schema.decodeTo(PoDocument, {
    decode: /* @__PURE__ */ SchemaGetter.transformEffect((text: string, options) =>
      Effect.fromResult(readPoText(text)).pipe(
        Effect.mapError((message) => new SchemaIssue.InvalidValue({ message }, text, options))
      )
    ),
    encode: /* @__PURE__ */ SchemaGetter.transform(writePoText),
  })
);
