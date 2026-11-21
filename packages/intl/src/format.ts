// The formatter: next-intl's `createFormatter` (v4.14.9) for one IntlInstance, on the process-wide Intl caches in
// icu.ts. Same methods, overloads, fallbacks and relative-time units; `relativeTime` takes its `now` explicitly.
//
// The relative-time unit thresholds and rounding are copied from next-intl's createFormatter.tsx.
// MIT License. Copyright (c) 2024 Jan Amann. Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { FormatSettings, NumberStyle, RelativeTimeFormatOptions } from "./icu";
import { cachedDateTimeFormat, cachedListFormat, cachedNumberFormat, cachedRelativeTimeFormat } from "./icu";

/** Options of `relativeTime`: next-intl's, with `now` required. */
export type RelativeTimeOptions = {
  /** The point in time `date` is phrased against. */
  readonly now: number | Date;
  /** A fixed unit; by default the largest that fits. */
  readonly unit?: Intl.RelativeTimeFormatUnit;
  /** The numbering system digits render in (`"arab"`). */
  readonly numberingSystem?: string;
  /** `long` (default), `short` or `narrow`. */
  readonly style?: Intl.RelativeTimeFormatStyle;
};

/**
 * Formats values in the instance's locale and zone, as next-intl's `useFormatter()` does. A named format is looked up
 * in the configured `formats` only; a name that is not there, or options `Intl` rejects, call `onError` and render
 * next-intl's fallback (`String(value)`).
 */
export type Format = {
  /**
   * Format a date or time in the configured zone, unless the options set their own.
   *
   * @param value - The date; a number is a UTC timestamp.
   * @param options - `Intl.DateTimeFormat` options.
   * @returns The formatted date.
   */
  dateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /**
   * Format a date or time with a named `dateTime` format, merged with `options`.
   *
   * @param value - The date; a number is a UTC timestamp.
   * @param format - The name of a configured `dateTime` format.
   * @param options - Options that override the named format's.
   * @returns The formatted date.
   */
  dateTime(value: Date | number, format?: string, options?: Intl.DateTimeFormatOptions): string;
  /**
   * Format a date range in the configured zone, unless the options set their own.
   *
   * @param start - The range's start; a number is a UTC timestamp.
   * @param end - The range's end; a number is a UTC timestamp.
   * @param options - `Intl.DateTimeFormat` options.
   * @returns The formatted range.
   */
  dateTimeRange(start: Date | number, end: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /**
   * Format a date range with a named `dateTime` format, merged with `options`.
   *
   * @param start - The range's start; a number is a UTC timestamp.
   * @param end - The range's end; a number is a UTC timestamp.
   * @param format - The name of a configured `dateTime` format.
   * @param options - Options that override the named format's.
   * @returns The formatted range.
   */
  dateTimeRange(
    start: Date | number,
    end: Date | number,
    format?: string,
    options?: Intl.DateTimeFormatOptions
  ): string;
  /**
   * Format a number.
   *
   * @param value - The number.
   * @param options - `Intl.NumberFormat` options.
   * @returns The formatted number.
   */
  number(value: number | bigint, options?: NumberStyle): string;
  /**
   * Format a number with a named `number` format, merged with `options`.
   *
   * @param value - The number.
   * @param format - The name of a configured `number` format.
   * @param options - Options that override the named format's.
   * @returns The formatted number.
   */
  number(value: number | bigint, format?: string, options?: NumberStyle): string;
  /**
   * Phrase a date relative to `now` ("2 hours ago", "in 3 days"), in the largest unit that fits.
   *
   * @param date - The date; a number is a UTC timestamp.
   * @param now - The point in time it is phrased against.
   * @returns The phrase.
   */
  relativeTime(date: Date | number, now: Date | number): string;
  /**
   * Phrase a date relative to `options.now`.
   *
   * @param date - The date; a number is a UTC timestamp.
   * @param options - `now`, and optionally a fixed unit, numbering system and style.
   * @returns The phrase.
   */
  relativeTime(date: Date | number, options: RelativeTimeOptions): string;
  /**
   * Join texts into a list ("a, b, and c").
   *
   * @param values - The items.
   * @param options - `Intl.ListFormat` options.
   * @returns The list.
   */
  list(values: Iterable<string>, options?: Intl.ListFormatOptions): string;
  /**
   * Join texts into a list with a named `list` format, merged with `options`.
   *
   * @param values - The items.
   * @param format - The name of a configured `list` format.
   * @param options - Options that override the named format's.
   * @returns The list.
   */
  list(values: Iterable<string>, format?: string, options?: Intl.ListFormatOptions): string;
};

/** A formatter method named a format the configured `formats` do not have (next-intl's `MISSING_FORMAT`). */
export class FormatNotFound extends Error {
  /** The error's tag. */
  readonly _tag = "FormatNotFound" as const;
  /** The `formats` kind looked in. */
  readonly kind: "dateTime" | "number" | "list";
  /** The name. */
  readonly format: string;

  /**
   * Name the missing format.
   *
   * @param kind - The `formats` kind looked in.
   * @param format - The name.
   */
  constructor(kind: "dateTime" | "number" | "list", format: string) {
    super(`Format \`${format}\` is not available in formats.${kind}.`);
    this.kind = kind;
    this.format = format;
  }
}

/** `Intl` rejected a formatter call's value or options (next-intl's `FORMATTING_ERROR`). */
export class FormatFailed extends Error {
  /** The error's tag. */
  readonly _tag = "FormatFailed" as const;
  /** The formatter method. */
  readonly method: keyof Format;
  /** What `Intl` threw. */
  override readonly cause: unknown;

  /**
   * Wrap what `Intl` threw.
   *
   * @param method - The formatter method.
   * @param cause - What `Intl` threw.
   */
  constructor(method: keyof Format, cause: unknown) {
    super(`format.${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.method = method;
    this.cause = cause;
  }
}

/**
 * The formatter for one instance's settings.
 *
 * @param settings - Locale, zone and formats.
 * @param report - The instance's error reporter; the key is the method (`format.dateTime`).
 * @returns The formatter.
 */
export function createFormat(
  { locale, timeZone, formats: { named } }: FormatSettings,
  report: (error: Error, key: string) => void
): Format {
  // next-intl's getFormattedValue: a named format from `styles` (its `kind`), or inline options, then the overrides.
  function formatted<O extends object>(
    method: keyof Format,
    [kind, styles]: readonly [FormatNotFound["kind"], Readonly<Record<string, O>>],
    formatOrOptions: string | O | undefined,
    overrides: O | undefined,
    format: (options: O | undefined) => string,
    fallback: () => string
  ): string {
    const key = `format.${method}`;

    // Own keys only, so a name like `toString` is missing rather than Object.prototype's.
    if (typeof formatOrOptions === "string" && !Object.hasOwn(styles, formatOrOptions)) {
      report(new FormatNotFound(kind, formatOrOptions), key);

      return fallback();
    }

    const base = typeof formatOrOptions === "string" ? styles[formatOrOptions] : formatOrOptions;

    try {
      return format(overrides === undefined ? base : { ...base, ...overrides });
    } catch (error) {
      report(new FormatFailed(method, error), key);

      return fallback();
    }
  }

  const zoned = (options: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormatOptions => ({
    ...options,
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- next-intl's applyTimeZone treats an empty zone as unset
    timeZone: options?.timeZone || timeZone,
  });

  function dateTime(
    value: Date | number,
    formatOrOptions?: string | Intl.DateTimeFormatOptions,
    overrides?: Intl.DateTimeFormatOptions
  ): string {
    return formatted(
      "dateTime",
      ["dateTime", named.dateTime],
      formatOrOptions,
      overrides,
      (options) => cachedDateTimeFormat(locale, zoned(options)).format(value),
      () => String(value)
    );
  }

  function dateTimeRange(
    start: Date | number,
    end: Date | number,
    formatOrOptions?: string | Intl.DateTimeFormatOptions,
    overrides?: Intl.DateTimeFormatOptions
  ): string {
    return formatted(
      "dateTimeRange",
      ["dateTime", named.dateTime],
      formatOrOptions,
      overrides,
      (options) => cachedDateTimeFormat(locale, zoned(options)).formatRange(start, end),
      () => [dateTime(start), dateTime(end)].join("\u2009–\u2009")
    );
  }

  function number(
    value: number | bigint,
    formatOrOptions?: string | NumberStyle,
    overrides?: NumberStyle
  ): string {
    return formatted(
      "number",
      ["number", named.number],
      formatOrOptions,
      overrides,
      (options) => cachedNumberFormat(locale, options).format(value),
      () => String(value)
    );
  }

  function relativeTime(date: Date | number, nowOrOptions: Date | number | RelativeTimeOptions): string {
    // Inside the try, as in next-intl: an untyped call without `now` reports and falls back.
    try {
      const { now, unit, numberingSystem, style } =
        typeof nowOrOptions === "number" || nowOrOptions instanceof Date
          ? { now: nowOrOptions }
          : nowOrOptions;
      const seconds = (new Date(date).getTime() - new Date(now).getTime()) / 1000;
      const resolvedUnit = unit ?? unitFor(seconds);
      // `numeric: "auto"` says "yesterday" only for whole days, so a rounded value across a day boundary would lie;
      // next-intl keeps "auto" for seconds alone, where it gives "now".
      const options: RelativeTimeFormatOptions = {
        style,
        numberingSystem,
        numeric: resolvedUnit === "second" ? "auto" : "always",
      };

      // Rounded: Intl.RelativeTimeFormat would print fractions ("2.1 hours ago").
      return cachedRelativeTimeFormat(locale, options).format(
        Math.round(seconds / UNIT_SECONDS[resolvedUnit]),
        resolvedUnit
      );
    } catch (error) {
      report(new FormatFailed("relativeTime", error), "format.relativeTime");

      return String(date);
    }
  }

  function list(
    values: Iterable<string>,
    formatOrOptions?: string | Intl.ListFormatOptions,
    overrides?: Intl.ListFormatOptions
  ): string {
    const items = [...values];

    return formatted(
      "list",
      ["list", named.list],
      formatOrOptions,
      overrides,
      (options) => cachedListFormat(locale, options).format(items),
      // oxlint-disable-next-line typescript/no-base-to-string -- next-intl's fallback is String(values) verbatim: "[object Set]" for a Set
      () => String(values)
    );
  }

  return { dateTime, dateTimeRange, number, relativeTime, list };
}

const SECOND = 1;
const MINUTE = SECOND * 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const WEEK = DAY * 7;
// next-intl's approximation.
const MONTH = DAY * (365 / 12);
const QUARTER = MONTH * 3;
const YEAR = DAY * 365;

const UNIT_SECONDS = {
  second: SECOND,
  seconds: SECOND,
  minute: MINUTE,
  minutes: MINUTE,
  hour: HOUR,
  hours: HOUR,
  day: DAY,
  days: DAY,
  week: WEEK,
  weeks: WEEK,
  month: MONTH,
  months: MONTH,
  quarter: QUARTER,
  quarters: QUARTER,
  year: YEAR,
  years: YEAR,
} as const satisfies Record<Intl.RelativeTimeFormatUnit, number>;

function unitFor(seconds: number): Intl.RelativeTimeFormatUnit {
  const abs = Math.abs(seconds);

  if (abs < MINUTE) {
    return "second";
  }

  if (abs < HOUR) {
    return "minute";
  }

  if (abs < DAY) {
    return "hour";
  }

  if (abs < WEEK) {
    return "day";
  }

  if (abs < MONTH) {
    return "week";
  }

  if (abs < YEAR) {
    return "month";
  }

  return "year";
}
