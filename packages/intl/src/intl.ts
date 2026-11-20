// Framework-free runtime: message descriptors, the typed `t`, and formatting with source fallback.
import type { GetICUArgs } from "@schummar/icu-type-parser";

import type { Catalog } from "./catalog";
import { CATALOG_VERSION, decodeAst, isLiteralSource, SOURCE_LOCALE } from "./catalog";
import type { Format } from "./format";
import { createFormat } from "./format";
import type { CompiledAst, FormatSettings, Formats, MessageValue, RichValues } from "./icu";
import { formatAst, fromAst, resolveFormats } from "./icu";
import { hashKey, keyOf } from "./message";

export type { Catalog } from "./catalog";
export type { Format, RelativeTimeOptions } from "./format";
export type { CompiledAst, Formats, MessageValue, RichValues } from "./icu";

/** What an `IntlInstance` is built from. Serializable, so a server can hand it to a client provider. */
export type IntlConfig = {
  /** Opaque locale id, passed to `Intl` as is. */
  readonly locale: string;
  /** The compiled catalog for `locale` (a `*.po` import, or `loadCatalog` from `@elmeragroup/intl-tools/compile`). */
  readonly catalog: Catalog;
  /** IANA zone every date and time formats in, so server and client agree. */
  readonly timeZone: string;
  /** Named styles messages refer to (`{d, date, short}`), with next-intl's shape and meaning. */
  readonly formats?: Formats;
};

declare const DESCRIPTOR: unique symbol;

/**
 * A message declared away from where it is translated. Only `msg()` makes one, so its text was extracted.
 *
 * @template M - The English ICU source as a literal type, which types `t.from`'s values; `string` when widened.
 */
export type Descriptor<M extends string = string> = {
  /** The English ICU source. */
  readonly message: M;
  /** The disambiguating context, when the source alone is ambiguous. */
  readonly context: string | undefined;
  readonly [DESCRIPTOR]: true;
};

/** Options of `msg()`. */
export type MessageOptions = {
  /** Disambiguates equal sources with different meanings (`"verb"` for the action "Open"). */
  readonly context?: string;
};

// next-intl's argument types: a plain `{x}` takes text only, so a number or date always names its format.
type IcuTypes = { ICUArgument: string; ICUNumberArgument: number | bigint; ICUDateArgument: Date };
type LooseValues = Readonly<Record<string, MessageValue>>;
// A union of messages (`t.from(STATUS[status])`) needs every member's arguments: any member may be the one shown.
type ArgsOfEach<M extends string> = M extends string ? (args: GetICUArgs<M, IcuTypes>) => void : never;
type Args<M extends string> =
  ArgsOfEach<M> extends (args: infer A) => void ? { [K in keyof A]: A[K] } : never;
type ValuesParam<V> = keyof V extends never ? [] : [values: V];
// A widened descriptor's message is unknown, so its values are untyped and optional.
type FromValues<M extends string> = string extends M ? [values?: LooseValues] : ValuesParam<Args<M>>;

/**
 * Translate a message. Takes a string literal only, so the extractor sees every message; the values are typed from
 * the literal's ICU arguments. A message declared elsewhere goes through `t.from(msg(...))`.
 */
export type Translate = {
  <const M extends string>(message: string extends M ? never : M, ...values: ValuesParam<Args<M>>): string;
  /**
   * Translate a `msg()` descriptor.
   *
   * @template M - The descriptor's message; its ICU arguments type the values.
   * @param descriptor - The descriptor `msg()` made.
   * @param values - The message's argument values.
   * @returns The translated text, or the source when no valid translation exists.
   */
  from<const M extends string>(descriptor: Descriptor<M>, ...values: FromValues<M>): string;
};

/** A message as `<T>` and `t` hand it to the formatter. */
export type MessageRef = {
  /** `keyOf(source, context)`: the catalog lookup and the key errors are reported under. */
  readonly key: string;
  /** The English source: what a key missing from the catalog renders, when it is plain text. */
  readonly source: string;
};

/**
 * A message from its English source.
 *
 * @param source - The ICU source.
 * @param context - Its context.
 * @returns The reference.
 */
export function sourceMessage(source: string, context: string | undefined): MessageRef {
  return { key: keyOf(source, context), source };
}

/** What formatting a message produced. */
export type FormatOutcome<R> =
  | { readonly _tag: "Formatted"; readonly value: string | R | Array<string | R> }
  /** The catalog has no entry for a structured source. Already reported; the caller renders the raw source or its children. */
  | { readonly _tag: "NotExtracted"; readonly source: string };

/** Rich formatting for `<T>`. Not part of the app API, so every app call site stays an extractable `t("literal")`. */
export type RichFormat = <R>(message: MessageRef, values: RichValues<R>) => FormatOutcome<R>;

/** Key of the rich formatter on an `IntlInstance`; only the package's `<T>` reads it. */
export const FORMAT: unique symbol = Symbol("elmera.intl.format");

/** Key of the error reporter on an `IntlInstance` (the `onError` option); only the package's `<T>` reads it. */
export const REPORT: unique symbol = Symbol("elmera.intl.report");

/** One locale's translator. */
export type IntlInstance = IntlConfig & {
  /** The typed translate function. */
  readonly t: Translate;
  /** Formats dates, numbers, relative times and lists in `locale` and `timeZone`, as next-intl's formatter. */
  readonly format: Format;
  readonly [FORMAT]: RichFormat;
  readonly [REPORT]: (error: Error, key: string) => void;
};

/** Options of `createIntl`. */
export type CreateIntlOptions = IntlConfig & {
  /**
   * Called with the message's key when a message fails to format (the call then throws: a caller bug the types and
   * `check` rule out) or is missing from the catalog though it has ICU syntax (it renders raw: not extracted yet), and
   * with the method (`format.dateTime`) when a `format` call fails (next-intl's fallback renders instead).
   */
  readonly onError?: (error: Error, key: string) => void;
};

/**
 * Declare a message for later translation with `t.from`. The text must be a literal (the extractor reads it here).
 *
 * @param message - The English ICU source, as a string literal.
 * @param options - `{ context }` as an object literal with a literal context.
 * @returns The descriptor.
 */
export function msg<const M extends string>(
  message: string extends M ? never : M,
  options?: MessageOptions
): Descriptor<M> {
  const descriptor: Omit<Descriptor<M>, typeof DESCRIPTOR> = { message, context: options?.context };

  // SAFETY: Descriptor's brand is a declared-only symbol, so no runtime value carries it. msg() is the only
  // constructor, which is what the brand promises: every descriptor's text sits in a literal the extractor read.
  return descriptor as Descriptor<M>;
}

/**
 * A key the catalog lacks, for a source with ICU syntax: the runtime has no parser, so the message renders raw until
 * `elmera-intl extract` (the dev watcher, about a second after a save) adds it and the catalog recompiles.
 */
export class MessageNotExtracted extends Error {
  /** The error's tag. */
  readonly _tag = "MessageNotExtracted" as const;

  /**
   * Name the source.
   *
   * @param source - The English ICU source.
   */
  constructor(
    /** The English ICU source. */
    readonly source: string
  ) {
    super(`not extracted yet: ${JSON.stringify(source)}; run \`elmera-intl extract\``);
  }
}

/** One catalog entry, decoded at its first lookup. */
type Entry = { readonly compiled: CompiledAst; readonly english: boolean };

/** A catalog's decoded entries and its English-marker keys, shared by every instance built from that catalog. */
type Decoded = { readonly entries: Map<string, Entry>; readonly english: ReadonlySet<string> };

// Per catalog object: a request's createIntl (and a provider's re-render) reuses the catalog's decoded entries.
const decodedByCatalog = new WeakMap<Catalog, Decoded>();

function decodedOf(catalog: Catalog): Decoded {
  const cached = decodedByCatalog.get(catalog);

  if (cached !== undefined) {
    return cached;
  }

  // A catalog from another compiler version would decode wrongly: a build or install defect, not a request's.
  if (catalog.v !== CATALOG_VERSION) {
    throw new Error(
      `@elmeragroup/intl: catalog version ${String(catalog.v)}, this runtime reads ${CATALOG_VERSION}; install matching @elmeragroup/intl and @elmeragroup/intl-tools`
    );
  }

  const decoded = { entries: new Map<string, Entry>(), english: new Set(catalog.e) };
  decodedByCatalog.set(catalog, decoded);

  return decoded;
}

// The catalog's entry for a message key, or undefined when the compiler left it out (or it was never extracted).
function lookup(catalog: Catalog, key: string): Entry | undefined {
  const { entries, english } = decodedOf(catalog);
  const hash = hashKey(key);
  const cached = entries.get(hash);

  if (cached !== undefined) {
    return cached;
  }

  const ir = Object.hasOwn(catalog.m, hash) ? catalog.m[hash] : undefined;

  if (ir === undefined) {
    return undefined;
  }

  const entry = { compiled: fromAst(decodeAst(ir)), english: english.has(hash) };
  entries.set(hash, entry);

  return entry;
}

/**
 * Create a translator for one locale and compiled catalog. It never parses ICU: each message formats from its catalog
 * entry, in `locale`, or in `en` for an entry compiled from the source for want of a translation. A key the catalog
 * lacks renders its plain source as is; dates and times format in `timeZone`, named styles resolve through `formats`.
 *
 * @param options - Locale, catalog, time zone, named styles and an optional error callback.
 * @returns The translator.
 * @throws When the catalog comes from another catalog version (mismatched packages: a defect).
 */
export function createIntl(options: CreateIntlOptions): IntlInstance {
  const { locale, catalog, timeZone, formats, onError } = options;
  const settings: FormatSettings = { locale, timeZone, formats: resolveFormats(formats) };
  const sourceSettings: FormatSettings = { ...settings, locale: SOURCE_LOCALE };
  const report = (error: Error, key: string) => {
    onError?.(error, key);
  };
  // Up front, so a catalog of another version fails at construction, not at its first message.
  decodedOf(catalog);
  const format: RichFormat = (message, values) => {
    const entry = lookup(catalog, message.key);

    if (entry === undefined) {
      const { source } = message;

      if (isLiteralSource(source)) {
        return { _tag: "Formatted", value: source };
      }

      report(new MessageNotExtracted(source), message.key);

      return { _tag: "NotExtracted", source };
    }

    // A missing or wrongly typed value is the caller's bug, which the types and check rule out: report, then throw.
    try {
      return {
        _tag: "Formatted",
        value: formatAst(entry.compiled, entry.english ? sourceSettings : settings, values),
      };
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)), message.key);
      throw error;
    }
  };
  const text = (message: MessageRef, values: Readonly<Record<string, MessageValue>>) => {
    // Only <T> renders tags: a function from an untyped caller is never called (it could be a translator).
    const outcome = format<string>(
      message,
      Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value !== "function"))
    );

    if (outcome._tag === "NotExtracted") {
      return outcome.source;
    }

    return Array.isArray(outcome.value) ? outcome.value.join("") : outcome.value;
  };
  const translate = (message: string, values?: Readonly<Record<string, MessageValue>>) =>
    text(sourceMessage(message, undefined), values ?? {});
  const from = (descriptor: Descriptor, values?: Readonly<Record<string, MessageValue>>) =>
    text(sourceMessage(descriptor.message, descriptor.context), values ?? {});
  // SAFETY: Translate's call signature and `from` only narrow the message to literals and type `values` from them; at
  // runtime they are these functions, which accept any message and values. TypeScript cannot check a generic
  // signature against a non-generic implementation.
  const t = Object.assign(translate, { from }) as Translate;
  const intl: IntlInstance = {
    locale,
    catalog,
    timeZone,
    formats,
    t,
    format: createFormat(settings, report),
    [FORMAT]: format,
    [REPORT]: report,
  };
  // Not enumerable: spreads, rests, Object.assign/values/entries never copy t, so it is only reachable by the
  // property name the extractor reads (`.t`, `["t"]`, `{ t }`). `format` likewise, so a spread instance stays the
  // serializable config.
  Object.defineProperty(intl, "t", { enumerable: false });
  Object.defineProperty(intl, "format", { enumerable: false });

  return intl;
}
