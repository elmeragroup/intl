// The app's locales and how a request picks one: the `lang` query parameter, then Accept-Language, then English. Pure:
// the intl middleware hands it what it read from the request. The negotiation is the host examples' `chooseLocale`
// (apps/next-example/intl/locale.ts), copied, since apps import nothing from each other.

/**
 * Every locale the API answers in: English, the source language, Norwegian Bokmål, Swedish and Finnish
 * (`src/intl/nb.po`, `src/intl/sv.po`, `src/intl/fi.po`). The type and the parser derive from it; `elmera-intl.json`
 * lists the same locales for the CLI.
 */
export const LOCALES = ["en", "nb", "sv", "fi"] as const;

/** A locale the API has a catalog for. */
export type Locale = (typeof LOCALES)[number];

/** The locale when neither the override nor Accept-Language names one the API ships. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Parse a locale the API ships from untrusted text, such as the `lang` parameter.
 *
 * @param value - The text to parse.
 * @returns The locale, or `undefined` when the API has no catalog for it.
 */
export function parseLocale(value: string | undefined): Locale | undefined {
  return LOCALES.find((locale) => locale === value);
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
// and its written standards resolve to Bokmål, the one the API ships.
function localeFor(range: string): Locale | undefined {
  const language = range.split("-")[0];

  return language === "no" || language === "nn" ? "nb" : parseLocale(language);
}

// The most preferred language in an Accept-Language header that the API ships. Weight 0 means "not acceptable"
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
 * The locale a request answers in: the `lang` parameter, else the client's Accept-Language, else English.
 *
 * @param override - The `lang` parameter's value, if any. One the API does not ship is no choice.
 * @param acceptLanguage - The request's Accept-Language header, if any.
 * @returns The request's locale.
 */
export function chooseLocale(override: string | undefined, acceptLanguage: string | undefined): Locale {
  return parseLocale(override) ?? negotiate(acceptLanguage ?? "") ?? DEFAULT_LOCALE;
}
