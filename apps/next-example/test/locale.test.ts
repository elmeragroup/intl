import { describe, expect, it } from "vitest";

import { chooseLocale } from "../intl/locale";

// Unit under test: chooseLocale, the negotiation the adapter runs on every request (the Playwright specs prove the
// adapter wires it in, with one browser that asks for Bokmål). Oracle, stated per row: RFC 9110 §12.4.2 for
// Accept-Language weights, RFC 4647 §2.1 for a language range's syntax and §3.4 for lookup, which drops a range's
// subtags until a shipped language matches; the rest is the app's own policy, written in locale.ts: a stored choice
// wins, Norwegian means Bokmål, equal weights keep the header's order, and English is the default. The app ships en,
// nb, sv and fi.
describe("chooseLocale", () => {
  it.each([
    // App policy: the stored choice wins; a stored value the app does not ship is no choice.
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
    // RFC 4647 §3.4: lookup drops `-NO` and finds `nb`.
    { stored: undefined, acceptLanguage: "nb-NO", locale: "nb", why: "lookup drops a region subtag" },
    { stored: undefined, acceptLanguage: "sv-SE", locale: "sv", why: "lookup drops Swedish's region subtag" },
    { stored: undefined, acceptLanguage: "fi-FI", locale: "fi", why: "lookup drops Finnish's region subtag" },
    // App policy: Norwegian (`no`) falls back to Bokmål, the written standard the app ships.
    { stored: undefined, acceptLanguage: "no", locale: "nb", why: "Norwegian falls back to Bokmål" },
    // RFC 9110 §12.4.2: weight 0 means "not acceptable", and `q` is case-insensitive.
    { stored: undefined, acceptLanguage: "nb;q=0", locale: "en", why: "weight 0 rules a language out" },
    {
      stored: undefined,
      acceptLanguage: "en;q=0.4, nb;Q=0.5",
      locale: "nb",
      why: "the higher weight wins, Q in capitals",
    },
    // RFC 9110 §12.4.2: a weight is 0 to 1 with at most three decimals; the app gives a malformed one no weight at all,
    // not the default 1.
    {
      stored: undefined,
      acceptLanguage: "nb;q=2, en;q=0.5",
      locale: "en",
      why: "a weight above 1 is malformed",
    },
    {
      stored: undefined,
      acceptLanguage: "nb;q=0.5000, en;q=0.4",
      locale: "en",
      why: "four decimals are malformed",
    },
    // RFC 9110 §12.4.2: the highest weight wins among all four shipped languages, wherever it stands in the header.
    {
      stored: undefined,
      acceptLanguage: "en;q=0.2, nb;q=0.4, sv;q=0.6, fi;q=0.8",
      locale: "fi",
      why: "the highest of four weights wins, last in the header",
    },
    {
      stored: undefined,
      acceptLanguage: "fi;q=0.3, sv-FI;q=0.9, nb;q=0.5, en;q=0.1",
      locale: "sv",
      why: "the highest of four weights wins, from a regional range",
    },
    // App policy: equal weights (0.400 is 0.4) keep the header's order.
    {
      stored: undefined,
      acceptLanguage: "en;q=0.4, nb;q=0.400",
      locale: "en",
      why: "a tie keeps the header's order",
    },
    {
      stored: undefined,
      acceptLanguage: "fi;q=0.7, sv;q=0.700",
      locale: "fi",
      why: "a tie between Finnish and Swedish keeps the header's order",
    },
    // RFC 4647 §2.1 allows no empty subtag, so `nb--NO` is no range and cannot win by its `nb`.
    {
      stored: undefined,
      acceptLanguage: "nb--NO, en;q=0.5",
      locale: "en",
      why: "a malformed range asks for nothing",
    },
  ] as const)("$why: $acceptLanguage → $locale", ({ stored, acceptLanguage, locale }) => {
    expect(chooseLocale(stored, acceptLanguage)).toBe(locale);
  });
});
