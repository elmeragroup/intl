import { describe, expect, it } from "vitest";

import { negotiateLocale } from "@elmeragroup/intl/core";

const NORWEGIAN = { no: "nb", nn: "nb" } as const;
const SHIPPED = ["en", "nb", "sv", "fi"] as const;

type Config = {
  readonly header: string | null | undefined;
  readonly locales: ReadonlyArray<string>;
  readonly aliases: Readonly<Record<string, string>>;
};
type Row = Config & { readonly locale: string | undefined; readonly why: string };
// A configuration error names what is wrong in it: the offending locales, alias key or target.
type Invalid = Config & { readonly names: ReadonlyArray<string> };

// Unit under test: negotiateLocale, through /core. Oracle, stated per row: RFC 9110 §12.4.2 for Accept-Language
// weights and their syntax (0 to 1, at most three decimals, weight 0 "not acceptable"), §5.6.3 for the optional
// whitespace around them (spaces and tabs), RFC 4647 §2.1 for a language
// range's syntax and §3.4 for lookup, whose own example truncates `zh-Hant-CN-x-private1-private2` →
// `zh-Hant-CN-x-private1` → `zh-Hant-CN` → `zh-Hant` → `zh`, dropping a single-character subtag left at the end. The
// rest is the function's contract, written in its JSDoc: a range resolves to the locale it names before its alias, a
// rejected range excludes the locale it names on every path and its alias target only through an alias, equal weights
// keep the header's order, and `*` is the caller's default. The rows before the first comment come from the example
// apps' former negotiation rows (en, nb, sv and fi, Norwegian as Bokmål), with the results the apps' own copies gave;
// the apps' own tests cover their lists.
describe("negotiateLocale", () => {
  it.each<Row>([
    {
      header: "de, fr;q=0.8",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: undefined,
      why: "no shipped language",
    },
    {
      header: "nb-NO",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "lookup drops a region subtag",
    },
    {
      header: "no",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "an alias: Norwegian is Bokmål",
    },
    {
      header: "nb;q=0",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: undefined,
      why: "weight 0 rules nb out",
    },
    {
      header: "no;q=0.9, nb;q=0, sv;q=0.8",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "sv",
      why: "a rejected Bokmål is no alias target for Norwegian",
    },
    {
      header: "no, nb;q=0",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: undefined,
      why: "Norwegian with Bokmål rejected",
    },
    {
      header: "nb-NO, nb;q=0, sv;q=0.8",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "sv",
      why: "a rejected Bokmål is no lookup prefix of nb-NO",
    },
    {
      header: "sv-FI, sv;q=0, fi;q=0.8",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "fi",
      why: "a rejected Swedish is no lookup prefix of sv-FI",
    },
    {
      header: "en;q=0.4, nb;Q=0.5",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "the higher weight wins, Q in capitals",
    },
    {
      header: "nb;q=2, en;q=0.5",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "en",
      why: "a weight above 1 is malformed, so the entry asks for nothing",
    },
    {
      header: "nb;q=0.5000, en;q=0.4",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "en",
      why: "four decimals are malformed",
    },
    {
      header: "en;q=0.2, nb;q=0.4, sv;q=0.6, fi;q=0.8",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "fi",
      why: "the highest of four weights wins, last in the header",
    },
    {
      header: "fi;q=0.3, sv-FI;q=0.9, nb;q=0.5, en;q=0.1",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "sv",
      why: "the highest of four weights wins, from a regional range",
    },
    {
      header: "en;q=0.4, nb;q=0.400",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "en",
      why: "a tie (0.400 is 0.4) keeps the header's order, the earlier locale first",
    },
    {
      header: "nb;q=0.400, en;q=0.4",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "a tie (0.400 is 0.4) keeps the header's order, not the alphabet's",
    },
    {
      header: "fi;q=0.7, sv;q=0.700",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "fi",
      why: "a tie keeps the header's order, the later locale first",
    },
    {
      header: "nb--NO, en;q=0.5",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "en",
      why: "an empty subtag is no range (§2.1), so nb--NO cannot win by its nb",
    },
    // Rejection: by exact name on every path, by alias target only through an alias, each range resolved exact-first.
    {
      header: "nb, nb-NO;q=0",
      locales: ["nb"],
      aliases: NORWEGIAN,
      locale: "nb",
      why: "rejecting nb-NO leaves nb",
    },
    {
      header: "nb-NO, nb-NO;q=0, sv;q=0.8",
      locales: ["nb", "sv"],
      aliases: NORWEGIAN,
      locale: "sv",
      why: "a rejected nb-NO does not fall back to nb",
    },
    {
      header: "nn, no;q=0",
      locales: ["nb"],
      aliases: NORWEGIAN,
      locale: undefined,
      why: "rejecting Norwegian rejects its alias target through an alias, so nn is not Bokmål",
    },
    {
      header: "nb, no;q=0",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "a rejected alias does not take away the nb the header names",
    },
    {
      header: "nb-NO, no;q=0",
      locales: SHIPPED,
      aliases: NORWEGIAN,
      locale: "nb",
      why: "lookup reaches nb by name, not through the rejected alias",
    },
    {
      header: "nb-NO;q=0, nn",
      locales: ["nb"],
      aliases: NORWEGIAN,
      locale: "nb",
      why: "a rejected nb-NO resolves to nothing, so it excludes nothing",
    },
    {
      header: "no-NO, no;q=0",
      locales: ["no", "nb"],
      aliases: { no: "nb" },
      locale: undefined,
      why: "exact-first: the rejected no names the shipped no, so lookup reaches neither no nor its alias's nb",
    },
    // Exact-first, on acceptance and on rejection, when an alias key is itself a shipped locale; and the longest
    // prefix first, whether it names a locale or an alias.
    {
      header: "sv;q=0.9, no",
      locales: ["no", "nb", "sv"],
      aliases: NORWEGIAN,
      locale: "no",
      why: "no names the shipped no before its alias, and its omitted weight is 1",
    },
    {
      header: "nn-NO, no;q=0",
      locales: ["no", "nb", "sv"],
      aliases: NORWEGIAN,
      locale: "nb",
      why: "a rejected no names the shipped no, so nn-NO still reaches Bokmål through its nn prefix",
    },
    {
      header: "no-NO",
      locales: ["no", "nb"],
      aliases: { no: "nb" },
      locale: "no",
      why: "a prefix naming a shipped locale is that locale, not its alias's target",
    },
    {
      header: "zh-HK-x-team",
      locales: ["zh", "zh-Hant"],
      aliases: { "zh-HK": "zh-Hant" },
      locale: "zh-Hant",
      why: "a regional alias is a longer prefix than the shipped zh, so it answers first",
    },
    {
      header: "nb-NO-x-test, nb-NO;q=0",
      locales: ["nb-NO", "nb"],
      aliases: {},
      locale: "nb",
      why: "only nb-NO is rejected, so its eligible parent answers",
    },
    {
      header: "en-GB-oxendict, en;q=0",
      locales: ["en-GB"],
      aliases: {},
      locale: "en-GB",
      why: "rejection is by exact name, not by prefix",
    },
    // Truncation (RFC 4647 §3.4): a single-character subtag left at the end goes with the subtag after it.
    {
      header: "en-x",
      locales: ["en-x", "en"],
      aliases: {},
      locale: "en-x",
      why: "the range itself is tried first, whatever its last subtag",
    },
    {
      header: "en-x-foo-a-b",
      locales: ["en-x-foo-a", "en-x-foo"],
      aliases: {},
      locale: "en-x-foo",
      why: "en-x-foo-a is skipped",
    },
    {
      header: "en-GB-x-a-b",
      locales: ["en-GB-x", "en-GB"],
      aliases: {},
      locale: "en-GB",
      why: "every single-character subtag at the end goes, not only one",
    },
    {
      header: "en-x-a-b-c",
      locales: ["en-x-a", "en"],
      aliases: {},
      locale: "en",
      why: "en-x-a is skipped",
    },
    {
      header: "x-team, sv;q=0.5",
      locales: ["en", "sv"],
      aliases: { x: "en" },
      locale: "sv",
      why: "x-team has no prefix, so the x alias is tried only on the exact range x",
    },
    // Case: ranges, locales and aliases compare case-insensitively; the answer is written as in locales.
    {
      header: "EN-gb",
      locales: ["en-GB"],
      aliases: {},
      locale: "en-GB",
      why: "the answer is written as in locales",
    },
    { header: "NO", locales: ["nb"], aliases: { No: "nb" }, locale: "nb", why: "an alias key in any case" },
    // The wildcard is the caller's default.
    {
      header: "*;q=1, sv;q=0.5",
      locales: ["en", "sv"],
      aliases: {},
      locale: "sv",
      why: "* names no locale, not the first one",
    },
    {
      header: "*;q=0, nb",
      locales: ["en", "nb"],
      aliases: {},
      locale: "nb",
      why: "a rejected * excludes nothing",
    },
    {
      header: "*",
      locales: ["nb"],
      aliases: {},
      locale: undefined,
      why: "a wildcard-only header is the default",
    },
    // Duplicates and malformed entries.
    {
      header: "sv;q=0.5, fi;q=0.6, sv;q=0.7",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "a duplicate range counts at its own weight",
    },
    {
      header: "nb;q=0.9;x=1, sv;q=0.5",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "a parameter after q drops the entry",
    },
    {
      header: "nb;level=1, sv;q=0.5",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "a parameter other than q is a malformed weight",
    },
    {
      header: "nb;q=, , ;q=1, nb-abcdefghi, sv;q=0.1",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "an empty weight, empty entries and a nine-character subtag ask for nothing",
    },
    // Optional whitespace (RFC 9110 §5.6.3) is spaces and tabs only, so a no-break space makes the entry malformed.
    {
      header: "nb, sv;q=0.5, nb;\u00A0q=0",
      locales: SHIPPED,
      aliases: {},
      locale: "nb",
      why: "a no-break space before q drops the rejection",
    },
    {
      header: "\u00A0nb,sv;q=0.5",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "a no-break space before the range drops the entry",
    },
    {
      header: "\tsv \t;\t q=1 , fi;q=0.5",
      locales: SHIPPED,
      aliases: {},
      locale: "sv",
      why: "spaces and tabs around the range and the weight are trimmed",
    },
    { header: "", locales: SHIPPED, aliases: {}, locale: undefined, why: "an empty header" },
    { header: null, locales: SHIPPED, aliases: {}, locale: undefined, why: "no header" },
    { header: undefined, locales: SHIPPED, aliases: {}, locale: undefined, why: "no header, undefined" },
  ])("$why: $header → $locale", ({ header, locales, aliases, locale }) => {
    expect(negotiateLocale(header, locales, { aliases })).toBe(locale);
  });

  it("takes no options", () => {
    expect(negotiateLocale("sv-FI", ["en", "sv"])).toBe("sv");
  });

  // Lookup walks a deep range back to its root (RFC 4647 §3.4): every prefix of this one is skipped until nb. How its
  // cost grows with the range is the benchmark's (`pnpm bench`), not this test's.
  it("falls back through 50,000 subtags to the root locale", () => {
    const range = ["nb", ...Array.from({ length: 49_999 }, () => "zz")].join("-");
    expect(negotiateLocale(range, SHIPPED, { aliases: NORWEGIAN })).toBe("nb");
  });

  // The configuration is checked on every call, before the header is read, so a wrong alias fails on the first
  // request whatever it carries, not only on a request that reaches it.
  it.each<Invalid>([
    { header: "en", locales: ["en", "EN"], aliases: {}, names: ["en", "EN"] },
    { header: "en", locales: ["en"], aliases: { no: "nb" }, names: ["no", "nb"] },
    { header: "en", locales: ["en-GB"], aliases: { gb: "en-gb" }, names: ["gb", "en-gb"] },
    { header: "en", locales: ["en"], aliases: { "*": "en" }, names: ["*"] },
    { header: "en", locales: ["en"], aliases: { "no-": "en" }, names: ["no-"] },
    { header: "en", locales: ["en"], aliases: { no: "en", NO: "en" }, names: ["NO"] },
    { header: "", locales: ["en"], aliases: { no: "nb" }, names: ["no", "nb"] },
    { header: null, locales: ["en"], aliases: { no: "nb" }, names: ["no", "nb"] },
    { header: undefined, locales: ["en"], aliases: { no: "nb" }, names: ["no", "nb"] },
  ])("throws a RangeError naming $names for header $header", ({ header, locales, aliases, names }) => {
    const call = () => negotiateLocale(header, locales, { aliases });
    expect(call).toThrow(RangeError);
    for (const name of names) {
      expect(call).toThrow(`"${name}"`);
    }
  });
});
