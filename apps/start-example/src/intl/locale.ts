// The app's locales and how a request picks one: the cookie the switcher writes, then the browser's
// Accept-Language, then English. Pure: the adapter hands it what it read from the request.

/**
 * Every locale the app ships, each under its own name so a visitor finds theirs whatever the page's language: English,
 * the source language, and Norwegian Bokmål (`src/intl/nb.po`). The type, the parser and the switcher's buttons derive
 * from it; `elmera-intl.json` lists the same locales for the CLI.
 */
export const LANGUAGES = [
  { locale: "en", name: "English" },
  { locale: "nb", name: "Norsk bokmål" },
] as const;

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

// A language range (RFC 4647 §2.1): `*`, or a primary subtag of 1 to 8 letters and subtags of 1 to 8 letters or digits.
const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z\d]{1,8})*)$/u;

// The locale a well-formed range asks for, by its primary subtag. Norwegian (`no`) and its written standards fall back
// to Bokmål, the one the app ships; a malformed range asks for nothing.
function fromLanguageRange(range: string): Locale | undefined {
  if (!LANGUAGE_RANGE.test(range)) {
    return undefined;
  }

  const language = range.split("-")[0]?.toLowerCase();

  return language === "no" || language === "nn" ? "nb" : parseLocale(language);
}

// An Accept-Language weight (RFC 9110 §12.4.2): `q` in either case, then 0 to 1 with at most three decimals.
const WEIGHT = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu;

type Preference = { readonly locale: Locale; readonly quality: number };

// One `range;q=weight` entry, when it names a locale the app ships at a positive weight. An entry without a weight
// weighs 1; weight 0 means "not this one"; one with a malformed weight, or anything after it, is dropped rather than
// given the default.
function parsePreference(entry: string): Preference | undefined {
  const [range = "", weight, ...rest] = entry.split(";");
  const locale = fromLanguageRange(range.trim());
  const quality =
    weight === undefined ? "1" : rest.length === 0 ? WEIGHT.exec(weight.trim())?.[1] : undefined;

  return locale === undefined || quality === undefined || Number(quality) === 0
    ? undefined
    : { locale, quality: Number(quality) };
}

// The most preferred language in an Accept-Language header that the app ships. The sort is stable, so equal weights
// keep the header's order.
function negotiate(acceptLanguage: string): Locale | undefined {
  return acceptLanguage
    .split(",")
    .map((entry) => parsePreference(entry))
    .filter((preference) => preference !== undefined)
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
