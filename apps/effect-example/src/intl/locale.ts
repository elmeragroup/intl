// The app's locales and how a request picks one: the `lang` query parameter, then Accept-Language, then English. Pure:
// the intl middleware hands it what it read from the request. Accept-Language is `negotiateLocale`'s, from
// `@elmeragroup/intl/core`; the override, the aliases and the default are the API's own policy.

import { negotiateLocale } from "@elmeragroup/intl/core";

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

// Norwegian (`no`) and its written standards stand for Bokmål, the one the API ships: `negotiateLocale` checks them
// along the lookup chain, after the locales themselves, so `nn-NO` is Bokmål too, and a rejected `no` keeps `nn` from
// Bokmål.
const ALIASES = { no: "nb", nn: "nb" } as const;

/**
 * The locale a request answers in: the `lang` parameter, else the client's Accept-Language, else English.
 *
 * @param override - The `lang` parameter's value, if any. One the API does not ship is no choice.
 * @param acceptLanguage - The request's Accept-Language header, if any.
 * @returns The request's locale.
 */
export function chooseLocale(override: string | undefined, acceptLanguage: string | undefined): Locale {
  return (
    parseLocale(override) ?? negotiateLocale(acceptLanguage, LOCALES, { aliases: ALIASES }) ?? DEFAULT_LOCALE
  );
}
