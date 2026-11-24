import { describe, expect, it } from "vitest";

import { chooseLocale } from "../src/intl/locale";

// Unit under test: chooseLocale, the app's policy around negotiateLocale, which the adapter runs on every request (the
// Playwright specs prove the adapter wires it in, with one browser that asks for Bokmål). Accept-Language itself is
// negotiateLocale's, tested against RFC 9110 and RFC 4647 in packages/intl/test/negotiate.test.ts. Oracle: the app's
// policy, written in locale.ts: a stored choice the app ships wins, Norwegian and Nynorsk mean Bokmål (and rejecting
// Norwegian keeps Nynorsk from Bokmål), and English is the default. The header-only rows guard the app's own list, which the package's test cannot
// reach: each shipped locale is one a header alone can pick. The app ships en, nb, sv and fi.
describe("chooseLocale", () => {
  it.each([
    { stored: "nb", acceptLanguage: "en", locale: "nb", why: "a stored locale wins" },
    { stored: "de", acceptLanguage: "nb", locale: "nb", why: "an unknown stored locale falls to the header" },
    { stored: "sv", acceptLanguage: "fi", locale: "sv", why: "a stored Swedish wins over the header" },
    { stored: "fi", acceptLanguage: null, locale: "fi", why: "a stored Finnish needs no header" },
    { stored: undefined, acceptLanguage: null, locale: "en", why: "no choice and no header: the default" },
    {
      stored: undefined,
      acceptLanguage: "de, fr;q=0.8",
      locale: "en",
      why: "no shipped language: the default",
    },
    {
      stored: undefined,
      acceptLanguage: "en, sv;q=0.5",
      locale: "en",
      why: "the header alone picks English",
    },
    { stored: undefined, acceptLanguage: "sv-SE", locale: "sv", why: "the header alone picks Swedish" },
    {
      stored: undefined,
      acceptLanguage: "fi-FI, en;q=0.5",
      locale: "fi",
      why: "the header alone picks Finnish",
    },
    { stored: undefined, acceptLanguage: "no", locale: "nb", why: "Norwegian falls back to Bokmål" },
    { stored: undefined, acceptLanguage: "nn-NO", locale: "nb", why: "Nynorsk falls back to Bokmål" },
    {
      stored: undefined,
      acceptLanguage: "nn, no;q=0",
      locale: "en",
      why: "rejecting Norwegian keeps Nynorsk from Bokmål",
    },
  ] as const)("$why: $acceptLanguage → $locale", ({ stored, acceptLanguage, locale }) => {
    expect(chooseLocale(stored, acceptLanguage)).toBe(locale);
  });
});
