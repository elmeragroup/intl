import { describe, expect, it } from "vitest";

import { chooseLocale } from "../src/intl/locale.ts";

// Unit under test: chooseLocale, the negotiation the intl middleware runs on every request (the HTTP tests prove the
// middleware wires it in, with the `lang` parameter and Accept-Language). Oracle, stated per row: RFC 9110 §12.4.2 for
// Accept-Language weights, RFC 4647 §2.1 for a language range's syntax and §3.4 for lookup, which drops a range's
// subtags until a shipped language matches; the rest is the API's own policy, written in locale.ts: the `lang`
// parameter wins, Norwegian means Bokmål, equal weights keep the header's order, and English is the default. The API
// ships en, nb, sv and fi.
describe("chooseLocale", () => {
  it.each([
    // API policy: the `lang` parameter wins; a value the API does not ship is no choice.
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
    // RFC 4647 §3.4: lookup drops `-NO` and finds `nb`.
    { override: undefined, acceptLanguage: "nb-NO", locale: "nb", why: "lookup drops a region subtag" },
    {
      override: undefined,
      acceptLanguage: "sv-SE",
      locale: "sv",
      why: "lookup drops Swedish's region subtag",
    },
    {
      override: undefined,
      acceptLanguage: "fi-FI",
      locale: "fi",
      why: "lookup drops Finnish's region subtag",
    },
    // API policy: Norwegian (`no`) falls back to Bokmål, the written standard the API ships.
    { override: undefined, acceptLanguage: "no", locale: "nb", why: "Norwegian falls back to Bokmål" },
    // RFC 9110 §12.4.2: weight 0 means "not acceptable", and `q` is case-insensitive.
    { override: undefined, acceptLanguage: "nb;q=0", locale: "en", why: "weight 0 rules a language out" },
    // RFC 9110 §12.4.2: weight 0 rules a language out wherever it stands, so the Norwegian fallback cannot pick the
    // Bokmål the client rejected.
    {
      override: undefined,
      acceptLanguage: "no;q=0.9, nb;q=0, sv;q=0.8",
      locale: "sv",
      why: "a rejected Bokmål is no fallback for Norwegian",
    },
    {
      override: undefined,
      acceptLanguage: "no, nb;q=0",
      locale: "en",
      why: "Norwegian with Bokmål rejected leaves the default",
    },
    // RFC 9110 §12.4.2 with RFC 4647 §3.4: a regional range looks up the language the client rejected by name, so the
    // rejection holds for it too, and the next acceptable language wins.
    {
      override: undefined,
      acceptLanguage: "nb-NO, nb;q=0, sv;q=0.8",
      locale: "sv",
      why: "a rejected Bokmål is no fallback for nb-NO",
    },
    {
      override: undefined,
      acceptLanguage: "sv-FI, sv;q=0, fi;q=0.8",
      locale: "fi",
      why: "a rejected Swedish is no fallback for sv-FI",
    },
    {
      override: undefined,
      acceptLanguage: "en;q=0.4, nb;Q=0.5",
      locale: "nb",
      why: "the higher weight wins, Q in capitals",
    },
    // RFC 9110 §12.4.2: a weight is 0 to 1 with at most three decimals; the API gives a malformed one no weight at all,
    // not the default 1.
    {
      override: undefined,
      acceptLanguage: "nb;q=2, en;q=0.5",
      locale: "en",
      why: "a weight above 1 is malformed",
    },
    {
      override: undefined,
      acceptLanguage: "nb;q=0.5000, en;q=0.4",
      locale: "en",
      why: "four decimals are malformed",
    },
    // RFC 9110 §12.4.2: the highest weight wins among all four shipped languages, wherever it stands in the header.
    {
      override: undefined,
      acceptLanguage: "en;q=0.2, nb;q=0.4, sv;q=0.6, fi;q=0.8",
      locale: "fi",
      why: "the highest of four weights wins, last in the header",
    },
    {
      override: undefined,
      acceptLanguage: "fi;q=0.3, sv-FI;q=0.9, nb;q=0.5, en;q=0.1",
      locale: "sv",
      why: "the highest of four weights wins, from a regional range",
    },
    // API policy: equal weights (0.400 is 0.4) keep the header's order.
    {
      override: undefined,
      acceptLanguage: "en;q=0.4, nb;q=0.400",
      locale: "en",
      why: "a tie keeps the header's order",
    },
    // RFC 4647 §2.1 allows no empty subtag, so `nb--NO` is no range and cannot win by its `nb`.
    {
      override: undefined,
      acceptLanguage: "nb--NO, en;q=0.5",
      locale: "en",
      why: "a malformed range asks for nothing",
    },
  ] as const)("$why: lang=$override, $acceptLanguage → $locale", ({ override, acceptLanguage, locale }) => {
    expect(chooseLocale(override, acceptLanguage)).toBe(locale);
  });
});
