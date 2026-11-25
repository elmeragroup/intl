import { describe, expect, it } from "vitest";

import { chooseLocale } from "../src/intl/locale.ts";

// Unit under test: chooseLocale, the API's policy around negotiateLocale, which the intl middleware runs on every
// request (the HTTP tests prove the middleware wires it in, with the `lang` parameter and Accept-Language).
// Accept-Language itself is negotiateLocale's, tested against RFC 9110 and RFC 4647 in
// packages/intl/test/negotiate.test.ts. Oracle: the API's policy, written in locale.ts: a `lang` parameter the API
// ships, written exactly, wins, Norwegian and Nynorsk mean Bokmål (and rejecting Norwegian keeps Nynorsk from
// Bokmål), and English is the default. The header-only rows guard the API's own list, which the package's test cannot
// reach: each shipped locale is one a header alone can pick. The API ships en, nb, sv and fi.
describe("chooseLocale", () => {
  it.each([
    { override: "nb", acceptLanguage: "en", locale: "nb", why: "the lang parameter wins" },
    { override: "de", acceptLanguage: "nb", locale: "nb", why: "an unknown lang falls to the header" },
    { override: "sv", acceptLanguage: "fi", locale: "sv", why: "lang=sv wins over the header" },
    { override: "fi", acceptLanguage: undefined, locale: "fi", why: "lang=fi needs no header" },
    { override: "NB", acceptLanguage: "sv", locale: "sv", why: "lang matches exactly, as the API writes it" },
    {
      override: undefined,
      acceptLanguage: undefined,
      locale: "en",
      why: "no choice and no header: the default",
    },
    {
      override: undefined,
      acceptLanguage: "de, fr;q=0.8",
      locale: "en",
      why: "no shipped language: the default",
    },
    {
      override: undefined,
      acceptLanguage: "en, sv;q=0.5",
      locale: "en",
      why: "the header alone picks English",
    },
    { override: undefined, acceptLanguage: "sv-SE", locale: "sv", why: "the header alone picks Swedish" },
    {
      override: undefined,
      acceptLanguage: "fi-FI, en;q=0.5",
      locale: "fi",
      why: "the header alone picks Finnish",
    },
    { override: undefined, acceptLanguage: "no", locale: "nb", why: "Norwegian falls back to Bokmål" },
    { override: undefined, acceptLanguage: "nn-NO", locale: "nb", why: "Nynorsk falls back to Bokmål" },
    {
      override: undefined,
      acceptLanguage: "nn, no;q=0",
      locale: "en",
      why: "rejecting Norwegian keeps Nynorsk from Bokmål",
    },
  ] as const)("$why: lang=$override, $acceptLanguage → $locale", ({ override, acceptLanguage, locale }) => {
    expect(chooseLocale(override, acceptLanguage)).toBe(locale);
  });
});
