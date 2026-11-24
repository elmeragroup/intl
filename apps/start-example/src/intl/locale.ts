// The app's locales and how a request picks one: the stored choice, then the browser's Accept-Language, then English.
// Pure: the adapter hands it what it read from the request. Accept-Language is `negotiateLocale`'s, from
// `@elmeragroup/intl/core`; the stored choice, the aliases and the default are the app's own policy.

import type { SupportedLocale } from "@elmeragroup/fuse/theme";
import { negotiateLocale } from "@elmeragroup/intl/core";

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

// The locales Accept-Language negotiates among, in the order `LANGUAGES` lists them.
const LOCALES: ReadonlyArray<Locale> = LANGUAGES.map(({ locale }) => locale);

// Norwegian (`no`) and its written standards stand for Bokmål, the one the app ships: `negotiateLocale` checks them
// along the lookup chain, after the locales themselves, so `nn-NO` is Bokmål too, and a rejected `no` keeps `nn` from
// Bokmål.
const ALIASES = { no: "nb", nn: "nb" } as const;

/**
 * The locale a request renders in: the stored choice, else the browser's preference, else English.
 *
 * @param stored - The locale cookie's value, if any.
 * @param acceptLanguage - The request's Accept-Language header, if any.
 * @returns The request's locale.
 */
export function chooseLocale(stored: string | undefined, acceptLanguage: string | null): Locale {
  return (
    parseLocale(stored) ?? negotiateLocale(acceptLanguage, LOCALES, { aliases: ALIASES }) ?? DEFAULT_LOCALE
  );
}
