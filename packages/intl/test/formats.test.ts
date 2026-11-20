import { describe, expect, it } from "vitest";

import type { Formats } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import { APP_FORMATS } from "./app-formats";
import { compiled } from "./catalogs";

const OSLO = "Europe/Oslo";
// 00:30 on Mar 5 in Oslo, still Mar 4 in UTC and on the host (America/Los_Angeles).
const minimum = new Date("2026-03-04T23:30:00Z");
const SOURCE = "Date must be exactly {minimum, date, short}";
// The adopting app's Zod `too_small.date.exact` translations.
const TRANSLATIONS = {
  en: "",
  no: "Dato må være nøyaktig {minimum, date, short}",
  sv: "Datum måste vara exakt {minimum, date, short}",
  fi: "Päivämäärän on oltava tarkalleen {minimum, date, short}",
} as const;
// The English-only messages the cases below format.
const OTHERS = [
  "On {minimum, date, full}",
  "In {minimum, date, reviewYear}",
  "At {minimum, time, long}",
  "On {minimum, date, nope}",
];

// The locale's catalog is compiled with the same formats the translator gets, as an app's loader compiles it.
function translator(locale: keyof typeof TRANSLATIONS, formats: Formats | undefined) {
  const messages = {
    [SOURCE]: TRANSLATIONS[locale],
    ...Object.fromEntries(OTHERS.map((other) => [other, ""])),
  };

  return createIntl({
    locale,
    catalog: compiled(locale, messages, formats),
    timeZone: OSLO,
    formats,
    onError: (error) => {
      throw error;
    },
  });
}

// Unit under test: `formats` overriding what a named style means. Oracle: next-intl 4.14.9's createTranslator output
// for the same messages, locale, zone and formats, copied by hand.
describe("formats", () => {
  it.each([
    ["en", "Date must be exactly Mar 5, 2026"],
    ["no", "Dato må være nøyaktig 5. mars 2026"],
    ["sv", "Datum måste vara exakt 5 mars 2026"],
    ["fi", "Päivämäärän on oltava tarkalleen 5.3.2026"],
  ] as const)("the adopting app's short date in %s renders as next-intl renders it", (locale, expected) => {
    expect(translator(locale, APP_FORMATS).t(SOURCE, { minimum })).toBe(expected);
  });

  // Same message, locale and zone, so only the formats tell the two translators' cached formatters apart.
  it("keeps instances with different formats apart in one process", () => {
    const configured = translator("no", APP_FORMATS);
    const builtIn = translator("no", undefined);

    expect([
      configured.t(SOURCE, { minimum }),
      builtIn.t(SOURCE, { minimum }),
      configured.t(SOURCE, { minimum }),
    ]).toEqual([
      "Dato må være nøyaktig 5. mars 2026",
      "Dato må være nøyaktig 5.3.26",
      "Dato må være nøyaktig 5. mars 2026",
    ]);
  });

  // An undefined option removes the built-in one it merges over (next-intl's "can modify existing global formats").
  it("keeps a style with an undefined option apart from one without it", () => {
    const full = "On {minimum, date, full}";
    const withoutWeekday = translator("en", { dateTime: { full: { weekday: undefined } } });
    const unchanged = translator("en", { dateTime: { full: {} } });

    expect([withoutWeekday.t(full, { minimum }), unchanged.t(full, { minimum })]).toEqual([
      "On March 5, 2026",
      "On Thursday, March 5, 2026",
    ]);
  });

  // The formats key describes options as passed; a caller changing its own options object afterwards must not
  // change what another instance with equal options renders.
  it("keeps an instance's styles when another caller mutates its own options", () => {
    const mutated: Intl.DateTimeFormatOptions = { year: "numeric" };
    const first = translator("en", { dateTime: { reviewYear: mutated } });
    const message = "In {minimum, date, reviewYear}";

    expect(first.t(message, { minimum })).toBe("In 2026");
    mutated.year = "2-digit";
    const second = translator("en", { dateTime: { reviewYear: { year: "numeric" } } });

    expect(second.t(message, { minimum })).toBe("In 2026");
  });

  it("feeds a dateTime style to {d, time, x} too", () => {
    expect(translator("en", APP_FORMATS).t("At {minimum, time, long}", { minimum })).toBe(
      "At March 5, 2026 at 12:30:00 AM GMT+1"
    );
  });

  it("renders the default format for a style no one configured, as next-intl does", () => {
    expect(translator("en", APP_FORMATS).t("On {minimum, date, nope}", { minimum })).toBe("On 3/5/2026");
  });
});
