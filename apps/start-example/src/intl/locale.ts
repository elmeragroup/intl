// The app's locales and how a request picks one: the stored choice, then the browser's Accept-Language, then English.
// Pure: the adapter hands it what it read from the request.

import type { SupportedLocale } from "@elmeragroup/fuse/theme";

/**
 * Every locale the app ships, each under its own name so a visitor finds theirs whatever the page's language: English,
 * the source language, Norwegian Bokmål, Swedish and Finnish (`src/intl/nb.po`, `src/intl/sv.po`, `src/intl/fi.po`).
 * `fuse` is the locale Fuse's own component strings and charts take for it (Fuse's `LocaleProvider`). The type, the
 * parser and the switcher's buttons derive from it; `elmera-intl.json` lists the same locales for the CLI.
 */
export const LANGUAGES = [
  { locale: "en", name: "English", fuse: "en-US" },
  { locale: "nb", name: "Norsk bokmål", fuse: "nb-NO" },
  { locale: "sv", name: "Svenska", fuse: "sv-SE" },
  { locale: "fi", name: "Suomi", fuse: "fi-FI" },
] as const satisfies ReadonlyArray<{
  readonly locale: string;
  readonly name: string;
  readonly fuse: SupportedLocale;
}>;

/** A locale the app has a catalog for. */
export type Locale = (typeof LANGUAGES)[number]["locale"];

/**
 * The cookie that stores the visitor's choice. Named for the app: browsers share cookies across ports on one host, so
 * on localhost a plain `locale` would carry this app's choice into the Next example.
 */
export const LOCALE_COOKIE = "start-example-locale";

/**
 * The `Cache-Control` of every response whose text depends on the request's locale. It varies by a cookie and by
 * Accept-Language, so a shared cache must not store it, and the browser must ask again after a switch.
 */
export const LOCALIZED_CACHE_CONTROL = "private, no-store";

/** The locale when neither a stored choice nor the browser names one the app ships. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Parse a locale the app ships from untrusted text, such as a cookie or a server function's argument.
 *
 * @param value - The text to parse.
 * @returns The locale, or `undefined` when the app has no catalog for it.
 */
export function parseLocale(value: string | undefined): Locale | undefined {
  return LANGUAGES.find(({ locale }) => locale === value)?.locale;
}

/**
 * The locale Fuse's components take for a locale the app ships.
 *
 * @param locale - The request's locale, as `useIntl()` reports it.
 * @returns Fuse's locale for it: English as `en-US`, the others with their country.
 */
export function fuseLocale(locale: string): SupportedLocale {
  return (LANGUAGES.find((language) => language.locale === locale) ?? LANGUAGES[0]).fuse;
}

// A language range (RFC 4647 §2.1): `*`, or a primary subtag of 1 to 8 letters and subtags of 1 to 8 letters or digits.
const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z\d]{1,8})*)$/u;

// An Accept-Language weight (RFC 9110 §12.4.2): `q` in either case, then 0 to 1 with at most three decimals.
const WEIGHT = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu;

// One well-formed `range;q=weight` entry, its range lowercased. An entry without a weight weighs 1; one with a
// malformed range or weight, or anything after the weight, is dropped rather than given the default.
type Entry = { readonly range: string; readonly quality: number };

function parseEntry(entry: string): ReadonlyArray<Entry> {
  const [range = "", weight, ...rest] = entry.split(";");
  const trimmed = range.trim();
  const quality =
    weight === undefined ? "1" : rest.length === 0 ? WEIGHT.exec(weight.trim())?.[1] : undefined;

  return LANGUAGE_RANGE.test(trimmed) && quality !== undefined
    ? [{ range: trimmed.toLowerCase(), quality: Number(quality) }]
    : [];
}

// The shipped locale a range resolves to, by its primary subtag: `nb-NO` is `nb`, `sv-FI` is `sv`. Norwegian (`no`)
// and its written standards resolve to Bokmål, the one the app ships.
function localeFor(range: string): Locale | undefined {
  const language = range.split("-")[0];

  return language === "no" || language === "nn" ? "nb" : parseLocale(language);
}

// The most preferred language in an Accept-Language header that the app ships. Weight 0 means "not acceptable"
// (RFC 9110 §12.4.2): each range first resolves to a shipped locale, and that locale is then dropped when the header
// rejects it by name, wherever the rejection stands, so no path to it (a region, the Norwegian alias) gets past the
// rejection: `nb-NO, nb;q=0` is not Bokmål, nor is `no;q=0.9, nb;q=0`. The sort is stable, so equal weights keep the
// header's order.
function negotiate(acceptLanguage: string): Locale | undefined {
  const entries = acceptLanguage.split(",").flatMap((entry) => parseEntry(entry));
  const rejected = new Set(entries.filter(({ quality }) => quality === 0).map(({ range }) => range));

  return entries
    .filter(({ quality }) => quality > 0)
    .flatMap(({ range, quality }) => {
      const locale = localeFor(range);

      return locale === undefined || rejected.has(locale) ? [] : [{ locale, quality }];
    })
    .toSorted((left, right) => right.quality - left.quality)[0]?.locale;
}

/**
 * The locale a request renders in: the stored choice, else the browser's preference, else English.
 *
 * @param stored - The locale cookie's value, if any.
 * @param acceptLanguage - The request's Accept-Language header, if any.
 * @returns The request's locale.
 */
export function chooseLocale(stored: string | undefined, acceptLanguage: string | null): Locale {
  return parseLocale(stored) ?? negotiate(acceptLanguage ?? "") ?? DEFAULT_LOCALE;
}
