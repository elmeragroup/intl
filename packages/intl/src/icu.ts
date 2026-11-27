// The runtime's ICU pipeline: prepare a compiled catalog's AST and format it. It never parses: the formatter it imports
// is intl-messageformat built without its parser (tsdown.config.ts), and the only parser is intl-tools' compiler.
// Caches are process-wide: a message formatter per compiled message, locale, zone and formats, an `Intl` formatter per
// locale and options.
import type {
  FormatXMLElementFn,
  Formatters,
  MessageFormatStyles,
} from "@elmeragroup/intl/internal/formatter";
import { IntlMessageFormat, MissingValueError } from "@elmeragroup/intl/internal/formatter";

/**
 * A value a message argument accepts: text for a plain `{x}` or a select, a number for `{x, number}`, plural and
 * selectordinal, a `Date` for `{x, date}` and `{x, time}`. A typed message narrows each argument to its kind.
 */
export type MessageValue = string | number | bigint | Date;

/**
 * A plain `{x}` got a value that is not text, from a caller the types did not check (a cast or `any`). Reported
 * like a missing argument: `onError`, then `t` throws it and `<T>` renders its children.
 */
export class PlainArgumentNotText extends Error {
  /** The error's tag. */
  readonly _tag = "PlainArgumentNotText" as const;
  /** The argument's name. */
  readonly argument: string;
  /** What the value is: its `typeof`, or `Date`. */
  readonly received: string;

  /**
   * Name the argument and what it got.
   *
   * @param argument - The argument's name.
   * @param received - What the value is: its `typeof`, or `Date`.
   */
  constructor(argument: string, received: string) {
    super(
      `argument "${argument}" got a ${received}: plain {${argument}} takes text; use {${argument}, number} or {${argument}, date}`
    );
    this.argument = argument;
    this.received = received;
  }
}

/**
 * A number, plural or selectordinal argument got a value that is not a number, or a date or time argument one that is
 * not a `Date` or a timestamp, from a caller the types did not check (a cast or `any`). The formatter would render a
 * number or date nobody gave (`null` as 0, `undefined` as NaN or as the current date), so it is reported like a missing
 * argument: `onError`, then `t` throws it and `<T>` renders its children. A `NaN` is a number the caller gave, so it
 * renders as given.
 */
export class ArgumentNotOfKind extends Error {
  /** The error's tag. */
  readonly _tag = "ArgumentNotOfKind" as const;
  /** The argument's name. */
  readonly argument: string;
  /** How the message reads it: `number`, `plural`, `selectordinal`, `date` or `time`. */
  readonly slot: string;
  /** What the value is: `null`, `Date`, or its `typeof`. */
  readonly received: string;

  /**
   * Name the argument, how the message reads it and what it got.
   *
   * @param argument - The argument's name.
   * @param slot - How the message reads it.
   * @param received - What the value is.
   */
  constructor(argument: string, slot: string, received: string) {
    super(
      `argument "${argument}" got ${received}: {${argument}, ${slot}} takes ${slot === "date" || slot === "time" ? "a Date" : "a number"}`
    );
    this.argument = argument;
    this.slot = slot;
    this.received = received;
  }
}

/**
 * Rich values `<T>` passes: ICU arguments plus positional tag renderers (`x0`). An argument may be a present `null`
 * or `undefined` (an untyped `<Val>`'s), which formats as `t()` formats it from an untyped caller.
 */
export type RichValues<R> = Readonly<
  Record<string, MessageValue | null | undefined | FormatXMLElementFn<R, R | string | Array<R | string>>>
>;

/**
 * next-intl's global `formats`: the named styles a message refers to (`{d, date, short}`, `{n, number, currency}`)
 * and the formatter's methods take by name (`format.dateTime(d, "long")`). In a message, a `dateTime` style serves
 * both `{d, date, x}` and `{d, time, x}`, a style named like a built-in one (`short`, `currency`) merges over it key by
 * key, and a style that is neither built in nor configured renders the kind's default format. The formatter looks a
 * name up in these styles only, with no built-ins, as next-intl's does. A date or time style without its own
 * `timeZone` formats in the configured zone.
 */
export type Formats = {
  /** Date and time styles, by name. */
  readonly dateTime?: Readonly<Record<string, Intl.DateTimeFormatOptions>>;
  /** Number styles, by name. */
  readonly number?: Readonly<Record<string, NumberStyle>>;
  /** List styles, by name; only the formatter's `list` reads them. */
  readonly list?: Readonly<Record<string, Intl.ListFormatOptions>>;
};

/** intl-messageformat's number options, as next-intl types a number style. */
export type NumberStyle = MessageFormatStyles["number"][string];

/** `Formats` prepared once for the formatter, with the id formatter caches are keyed by. */
export type ResolvedFormats = {
  /** Equal for equal formats, distinct otherwise. */
  readonly id: string;
  /** The styles in intl-messageformat's shape. */
  readonly styles: Partial<MessageFormatStyles>;
  /** The app's styles as configured, frozen: the formatter's named lookup, which merges over no built-in. */
  readonly named: {
    readonly dateTime: Readonly<Record<string, Readonly<Intl.DateTimeFormatOptions>>>;
    readonly number: Readonly<Record<string, Readonly<NumberStyle>>>;
    readonly list: Readonly<Record<string, Readonly<Intl.ListFormatOptions>>>;
  };
};

const resolvedByKey = new Map<string, ResolvedFormats>();

/**
 * Prepare formats for `formatAst`: next-intl's `dateTime` feeds intl-messageformat's `date` and `time`, which merge
 * each style over the built-in one of the same name. Once per distinct value for the whole process, bounded by the
 * configs an app passes.
 *
 * @param formats - The app's formats, if any.
 * @returns The prepared formats, shared by every instance with equal formats.
 */
export function resolveFormats(formats: Formats | undefined): ResolvedFormats {
  return memoized(resolvedByKey, formatsKey(formats), () => {
    const dateTime = frozenCopies(formats?.dateTime);
    const number = frozenCopies(formats?.number);

    return {
      id: String(resolvedByKey.size),
      styles: { date: dateTime, time: dateTime, number },
      named: { dateTime, number, list: frozenCopies(formats?.list) },
    };
  });
}

// The cache key describes each style's options as passed, so the cache keeps its own frozen copies: a caller changing
// its options object later must not change what another instance with equal formats renders.
function frozenCopies<O extends Intl.DateTimeFormatOptions | NumberStyle | Intl.ListFormatOptions>(
  styles: Readonly<Record<string, O>> = {}
): Record<string, Readonly<O>> {
  return Object.fromEntries(
    Object.entries(styles).map(([name, options]) => [name, Object.freeze<O>({ ...options })])
  );
}

// Options as entry lists, so an undefined option stays in the key (as null): `{ full: { weekday: undefined } }` removes
// the built-in weekday (the merge spreads it over), `{ full: {} }` keeps it.
function formatsKey(formats: Formats | undefined): string {
  return JSON.stringify([
    styleEntries(formats?.dateTime),
    styleEntries(formats?.number),
    styleEntries(formats?.list),
  ]);
}

function styleEntries<O extends Intl.DateTimeFormatOptions | NumberStyle | Intl.ListFormatOptions>(
  styles: Readonly<Record<string, O>> = {}
): Array<[string, Array<[string, unknown]>]> {
  return Object.entries(styles).map(([name, options]) => [name, Object.entries(options)]);
}

/** Where a message formats: its locale, the zone for dates and times, and the app's named styles. */
export type FormatSettings = {
  /** The locale numbers, dates and plurals format in. */
  readonly locale: string;
  /** The IANA zone for dates and times. */
  readonly timeZone: string;
  /** The named styles messages refer to. */
  readonly formats: ResolvedFormats;
};

/** One node of a parsed ICU message, as intl-messageformat's parser returns it. */
export type MessageFormatElement = ReturnType<IntlMessageFormat["getAst"]>[number];

/** How a message reads an argument the formatter checks: as text (`{x}`), a number, or a date. */
type Slot = "plain" | "number" | "plural" | "selectordinal" | "date" | "time";

/** A message prepared for `formatAst`. */
export type CompiledAst = {
  /**
   * The parsed message with every plain `{x}`, and every number or date argument inside a branch, renamed to a
   * reserved argument per slot, which the formatter fills with the caller's value once it is of the slot's kind.
   */
  readonly ast: ReadonlyArray<MessageFormatElement>;
  /**
   * Each slot and argument name the message reads, each pair once, and whether it is a number or date argument outside
   * every branch: always read, so checked before formatting and left under its own name.
   */
  readonly args: ReadonlyArray<Arg>;
};

/** A slot and argument name a message reads, read always (checked eagerly) or through its reserved argument. */
type Arg =
  | readonly [slot: Exclude<Slot, "plain">, name: string, isRead: true]
  | readonly [slot: Slot, name: string, isRead: false];

/**
 * Prepare a parsed (or decoded) AST for `formatAst`: rename its arguments. No parser involved.
 *
 * @param ast - The message's AST.
 * @returns The compiled message.
 */
export function fromAst(ast: ReadonlyArray<MessageFormatElement>): CompiledAst {
  const args = new Map<string, Arg>();
  const renamed = renameArgs(ast, args, false);

  return { ast: renamed, args: [...args.values()] };
}

/**
 * Format a compiled message. Dates and times format in the settings' zone, never the host's.
 *
 * @template R - What tag renderers return (React nodes for `<T>`).
 * @param compiled - The compiled message.
 * @param settings - The locale it is written in, the zone and the named styles.
 * @param values - Argument values and tag renderers.
 * @returns The formatted message: text, or parts when a tag renderer returned a non-string.
 * @throws When an argument of the selected branch is missing, a plain one is not text (`PlainArgumentNotText`), a
 *   number or date one is not of its kind (`ArgumentNotOfKind`), or the formatter rejects a value.
 */
export function formatAst<R>(
  compiled: CompiledAst,
  settings: FormatSettings,
  values: RichValues<R>
): string | R | Array<string | R> {
  const formatValues = { ...values };
  // The formatter reads an argument in a branch only when the branch is selected, so an unselected branch's value is
  // never checked or formatted and may be left out, and a missing selected one fails naming the caller's argument, not
  // the reserved one.
  for (const [slot, name, isRead] of compiled.args) {
    const isSupplied = Object.hasOwn(values, name);
    const value = isSupplied ? values[name] : undefined;

    // A tag renderer is <T>'s own, under a name the walk reserves (x0), never a message argument's.
    if (typeof value === "function") {
      continue;
    }

    // An argument outside every branch is always read: check it here, and let the formatter read it as given (a
    // missing one fails in the formatter, naming it).
    if (isRead) {
      if (isSupplied) {
        ofKind(slot, name, value);
      }

      continue;
    }

    Object.defineProperty(formatValues, reserved(slot, name), {
      get: () => {
        if (!isSupplied) {
          throw new MissingValueError(name);
        }

        return slot === "plain" ? asText(name, value) : ofKind(slot, name, value);
      },
    });
  }

  return messageFormat(compiled, settings).format<R>(formatValues);
}

// The reserved argument a slot's `{x}` is renamed to; formatAst fills it with x once it is of the slot's kind. The NUL
// cannot occur in a parsed ICU argument name, so it never meets a caller's argument.
function reserved(slot: Slot, name: string): string {
  return `\u0000${slot}\u0000${name}`;
}

// The slot each ICU element type reads, by TYPE in @formatjs/icu-messageformat-parser (which intl-messageformat does
// not re-export): argument 1, number 2, date 3, time 4, plural 6. A select (5) reads any value as written text.
const SLOTS: ReadonlyArray<Slot | undefined> = [
  undefined,
  "plain",
  "number",
  "date",
  "time",
  undefined,
  "plural",
];

// The AST with every plain `{x}`, and every number or date argument in a branch, renamed to its reserved argument, per
// occurrence: `{n} {n, plural, …}` checks n as text in one and as a number in the other. A number or date argument
// outside every branch keeps its name, marked as always read.
function renameArgs(
  elements: ReadonlyArray<MessageFormatElement>,
  args: Map<string, Arg>,
  isInBranch: boolean
): Array<MessageFormatElement> {
  return elements.map((element): MessageFormatElement => {
    if ("children" in element) {
      return { ...element, children: renameArgs(element.children, args, isInBranch) };
    }

    const slot =
      "pluralType" in element && element.pluralType === "ordinal" ? "selectordinal" : SLOTS[element.type];
    let renamed = element;

    if (slot !== undefined && "value" in element) {
      const name = reserved(slot, element.value);

      if (slot !== "plain" && !isInBranch) {
        args.set(`${name}\u0000`, [slot, element.value, true]);
      } else {
        args.set(name, [slot, element.value, false]);
        renamed = { ...element, value: name };
      }
    }

    if ("options" in renamed) {
      const options = Object.fromEntries(
        Object.entries(renamed.options).map(([key, option]) => [
          key,
          { ...option, value: renameArgs(option.value, args, true) },
        ])
      );

      return { ...renamed, options };
    }

    return renamed;
  });
}

// An argument's value as a caller passed it: typed callers pass a MessageValue, untyped ones anything.
type ArgumentValue = MessageValue | null | undefined;

// A present `undefined` or `null` (untyped callers pass them) renders as nothing, as intl-messageformat renders it
// for next-intl.
function asText(name: string, value: ArgumentValue): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  throw new PlainArgumentNotText(name, value instanceof Date ? "Date" : typeof value);
}

// A number slot takes a number (NaN too: the caller's own, which renders as NaN) or bigint, or a string Intl reads as
// one ("3", which the formatter renders as given); a date slot takes a Date or a timestamp. Anything else the formatter
// would turn into a number or date nobody gave: null as 0, an empty string as 0, undefined and other text as NaN, a
// boolean as 0 or 1, and in a date undefined as the current instant. An invalid Date or a NaN timestamp still fails in
// Intl, as before. A Date is told by its brand, not `instanceof`, so another realm's (an iframe's, `node:vm`'s) passes.
function ofKind(slot: Exclude<Slot, "plain">, name: string, value: ArgumentValue): ArgumentValue {
  const isOfKind =
    typeof value === "number" ||
    (slot === "date" || slot === "time"
      ? isDate(value)
      : typeof value === "bigint" ||
        (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))));

  if (isOfKind) {
    return value;
  }

  throw new ArgumentNotOfKind(name, slot, value === null ? "null" : isDate(value) ? "Date" : typeof value);
}

function isDate(value: ArgumentValue): boolean {
  return Object.prototype.toString.call(value) === "[object Date]";
}

// A formatter per compiled message, locale, zone and formats (a named style resolves at construction). Keyed by the
// compiled object, so the formatter goes when its message does.
// Constructing one resolves the locale, so it stays off the per-call path.
const messageFormats = new WeakMap<CompiledAst, Map<string, IntlMessageFormat>>();

function messageFormat(
  compiled: CompiledAst,
  { locale, timeZone, formats }: FormatSettings
): IntlMessageFormat {
  const bySettings = memoized(messageFormats, compiled, () => new Map<string, IntlMessageFormat>());

  return memoized(
    bySettings,
    `${locale}\u0000${timeZone}\u0000${formats.id}`,
    () =>
      new IntlMessageFormat([...compiled.ast], locale, formats.styles, {
        formatters: formattersFor(timeZone),
      })
  );
}

// Intl formatters by constructor arguments, shared by messages and the formatter. A new Intl.DateTimeFormat costs
// ~20 µs, a cached one nothing; the keys are the locales and options call sites use, so the maps stay as small as the
// app's set of styles.
const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();
const formattersByZone = new Map<string, Formatters>();

/**
 * The process-wide `Intl.NumberFormat` for these arguments.
 *
 * @param locales - The locales.
 * @param options - The options.
 * @returns The cached formatter.
 * @throws When `Intl` rejects the options (a `RangeError`).
 */
export function cachedNumberFormat(
  locales: Intl.LocalesArgument,
  options: NumberStyle | undefined
): Intl.NumberFormat {
  // SAFETY: a number style carries options and values ES2023's Intl.NumberFormat v3 added (`roundingMode`,
  // `useGrouping: "always"`), which the runtime's ES2022 library does not declare. An ES2022 engine's
  // InitializeNumberFormat (ECMA-402 9th edition) does not read an option it does not name; reads `useGrouping` with
  // GetOption type "boolean", so ToBoolean makes every non-empty string (`"always"`, `"min2"`) `true`, the locale's
  // ordinary grouping; and throws a RangeError on a value outside an enumeration it reads (`signDisplay: "negative"`),
  // as the @throws above documents for any options `Intl` rejects.
  return memoized(
    numberFormats,
    JSON.stringify([locales, options]),
    () => new Intl.NumberFormat(locales, options as Intl.NumberFormatOptions | undefined)
  );
}

/**
 * The process-wide `Intl.DateTimeFormat` for these arguments. The caller sets the zone; none means the host's.
 *
 * @param locales - The locales.
 * @param options - The options, with the zone.
 * @returns The cached formatter.
 * @throws When `Intl` rejects the options (a `RangeError`).
 */
export function cachedDateTimeFormat(
  locales: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions | undefined
): Intl.DateTimeFormat {
  return memoized(
    dateTimeFormats,
    JSON.stringify([locales, options]),
    () => new Intl.DateTimeFormat(locales, options)
  );
}

/** `Intl.RelativeTimeFormat`'s options; ECMA-402 has `numberingSystem`, TypeScript's lib omits it. */
export type RelativeTimeFormatOptions = Intl.RelativeTimeFormatOptions & {
  readonly numberingSystem?: string;
};

/**
 * The process-wide `Intl.RelativeTimeFormat` for these arguments.
 *
 * @param locale - The locale.
 * @param options - The options.
 * @returns The cached formatter.
 * @throws When `Intl` rejects the options (a `RangeError`).
 */
export function cachedRelativeTimeFormat(
  locale: string,
  options: RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  return memoized(
    relativeTimeFormats,
    JSON.stringify([locale, options]),
    () => new Intl.RelativeTimeFormat(locale, options)
  );
}

/**
 * The process-wide `Intl.ListFormat` for these arguments.
 *
 * @param locale - The locale.
 * @param options - The options.
 * @returns The cached formatter.
 * @throws When `Intl` rejects the options (a `RangeError`).
 */
export function cachedListFormat(
  locale: string,
  options: Intl.ListFormatOptions | undefined
): Intl.ListFormat {
  return memoized(listFormats, JSON.stringify([locale, options]), () => new Intl.ListFormat(locale, options));
}

function formattersFor(timeZone: string): Formatters {
  return memoized(formattersByZone, timeZone, (): Formatters => ({
    getNumberFormat: cachedNumberFormat,
    // Every date/time (named styles, plain {d, date}, skeletons) formats in the configured zone, unless its named
    // style sets its own, as next-intl applies the zone.
    getDateTimeFormat: (locales, options) =>
      cachedDateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? timeZone }),
    getPluralRules: (locales, options) =>
      memoized(pluralRules, JSON.stringify([locales, options]), () => new Intl.PluralRules(locales, options)),
  }));
}

function memoized<K, V>(
  cache: { get(key: K): V | undefined; set(key: K, value: V): void },
  key: K,
  create: () => V
): V {
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const created = create();
  cache.set(key, created);

  return created;
}
