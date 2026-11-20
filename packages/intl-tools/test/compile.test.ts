import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";
import { hashKey, SERIALIZER_VERSION } from "@elmeragroup/intl/internal/message";

import type { CompileProblem, UnreachableArm } from "../src/compile";
import { compileCatalog, loadCatalog } from "../src/compile";
import { formatPo } from "../src/po";

type Entry = { readonly source: string; readonly translation: string; readonly context?: string };

function po(locale: string, entries: ReadonlyArray<Entry>): string {
  return formatPo(
    locale,
    entries.map(({ source, translation, context }) => ({
      source,
      translation,
      context,
      references: [],
      comments: [],
      flags: [],
    }))
  );
}

function problems(locale: string, entries: ReadonlyArray<Entry>): ReadonlyArray<CompileProblem> {
  const compiled = compileCatalog(po(locale, entries), locale);

  return compiled._tag === "Compiled" ? [] : compiled.problems;
}

// The unreachable arms, as `arm reason`, or the compile error's message when it fails.
function unreachable(locale: string, entries: ReadonlyArray<Entry>): ReadonlyArray<string> {
  const compiled = compileCatalog(po(locale, entries), locale);

  return compiled._tag === "Compiled"
    ? compiled.unreachable.map(({ arm, reason }: UnreachableArm) => `${arm} ${reason}`)
    : [compiled.message];
}

// The catalog as it reaches a browser: through JSON.
function shipped(locale: string, entries: ReadonlyArray<Entry>): Catalog {
  const compiled = compileCatalog(po(locale, entries), locale);

  if (compiled._tag !== "Compiled") {
    throw compiled;
  }

  const value: unknown = JSON.parse(JSON.stringify(compiled.catalog));

  // SAFETY: the JSON round trip of a compiled catalog, which is what this test hands the runtime on purpose.
  return value as Catalog;
}

// Unit under test: compileCatalog's validation of the artifact it emits. Oracle: Intl's own verdict on each option
// (it rejects the currency "NOKK" and cannot scale a bigint by 0.5), and each locale's CLDR plural rules.
describe("dry-format", () => {
  it("fails a translation whose number skeleton names a currency Intl rejects (node pass)", () => {
    const source = "{n, number, ::currency/NOK}";

    const [problem, ...others] = problems("no", [{ source, translation: "{n, number, ::currency/NOKK}" }]);

    expect([problem?.key, problem?.pass, others]).toEqual([source, "node", []]);
    expect(problem?.reason).toMatch(/Invalid currency code : NOKK/);
    expect(problems("no", [{ source, translation: source }])).toEqual([]);
  });

  it("fails a scale a bigint cannot take (node pass)", () => {
    const source = "{n, number, ::scale/0.5}";

    const [problem, ...others] = problems("no", [{ source, translation: source }]);

    expect([problem?.pass, others]).toEqual(["node", []]);
    expect(problem?.reason).toMatch(/fractional scale 0.5 to bigint/);
  });

  // Every fixed sample selects `other` here; only a value whose offset difference is `one` in Finnish reaches the arm.
  // The node pass formats the arm's node whether or not a value reaches it; the branch pass reaches it too.
  it("fails a currency in an arm only an offset selects, and reaches that arm", () => {
    const source = "{n, plural, offset:100 one {one} other {# other}}";

    const [problem, ...others] = problems("fi", [
      { source, translation: "{n, plural, offset:100 one {{n, number, ::currency/NOKK}} other {# muuta}}" },
    ]);

    expect([problem?.pass, others]).toEqual(["node", []]);
    expect(problem?.reason).toMatch(/Invalid currency code : NOKK/);
    expect(
      unreachable("fi", [
        { source, translation: "{n, plural, offset:100 one {{n, number}} other {# muuta}}" },
      ])
    ).toEqual([]);
  });

  // Finnish `one` is 1, so `one` takes n = 10001 here, far outside any fixed window around 0.
  it("reaches a category arm through a large offset", () => {
    const source = "{n, plural, offset:10000 one {one arm} other {# other}}";
    const entries = [{ source, translation: "{n, plural, offset:10000 one {one arm} other {# muuta}}" }];

    expect(unreachable("fi", entries)).toEqual([]);
    expect(
      createIntl({ locale: "fi", catalog: shipped("fi", entries), timeZone: "UTC" }).t(source, { n: 10001 })
    ).toBe("one arm");
  });

  // Finnish has no `few` (CLDR: one, other), so its plural rules prove the arm dead, and the compile passes.
  it("reports a category the locale never produces as unreachable", () => {
    const source = "{n, plural, one {# item} other {# items}}";

    expect(
      unreachable("fi", [
        { source, translation: "{n, plural, one {# kohde} few {# kohdetta} other {# kohdetta}}" },
      ])
    ).toEqual(["n:few category-absent"]);
  });

  // en `one` is 1 and -1 only, and the exact arms take both; the search cannot prove that, so it lists the arm as not
  // sampled, and the compile passes.
  it("compiles and lists a category arm no sample reaches", () => {
    const source = "{n, plural, =1 {exact one} =-1 {exact minus one} one {category one} other {other}}";

    expect(unreachable("en", [{ source, translation: "" }])).toEqual(["n:one not-sampled"]);
  });

  // The ICU parser requires the inner `other`, yet no value is `one` for the outer plural and not `one` for the inner:
  // one argument, one category. Every locale compiles it, with that arm shadowed.
  it.each(["en", "ar", "pl", "ru", "fr", "cy"])("compiles nested plurals on one argument in %s", (locale) => {
    const source = "{n, plural, one {{n, plural, one {I} other {J}}} other {O}}";

    expect(unreachable(locale, [{ source, translation: locale === "en" ? "" : source }])).toEqual([
      "n:one>n:other shadowed",
    ]);
  });

  // French `many` is 1e6 and its multiples; the exact arms take 1e6, 2e6 and 1e9, and n = 3000000 still reaches `many`.
  it("reaches French many past the exact magnitudes", () => {
    const source =
      "{n, plural, =1000000 {a million} =2000000 {two million} =1000000000 {a billion} many {many} other {other}}";
    const entries = [{ source, translation: source }];

    expect(unreachable("fr", entries)).toEqual([]);
    expect(
      createIntl({ locale: "fr", catalog: shipped("fr", entries), timeZone: "UTC" }).t(source, { n: 3000000 })
    ).toBe("many");
  });

  // s = "a" selects the outer `a`, then the inner `other`: one value, both selectors.
  it("samples nested selects on one argument with one value", () => {
    const source = "{s, select, a {{s, select, b {B} other {inner other}}} other {outer other}}";
    const entries = [{ source, translation: "" }];

    expect(unreachable("en", entries)).toEqual(["s:a>s:b shadowed"]);
    expect(
      createIntl({ locale: "en", catalog: shipped("en", entries), timeZone: "UTC" }).t(source, { s: "a" })
    ).toBe("inner other");
  });

  // n = 5 is `other` in en, so it selects the outer `other` and then the inner `=5`.
  it("samples nested plurals on one argument with one value", () => {
    const source = "{n, plural, one {one} other {{n, plural, =5 {five} other {many}}}}";
    const entries = [{ source, translation: "" }];

    expect(unreachable("en", entries)).toEqual([]);
    expect(
      createIntl({ locale: "en", catalog: shipped("en", entries), timeZone: "UTC" }).t(source, { n: 5 })
    ).toBe("five");
  });
});

// Unit under test: the codec through compileCatalog and the runtime. Oracle: next-intl's rendering of offset plurals
// and ordinals, which the IR must carry through JSON (icu-minify drops the offset).
describe("codec", () => {
  it("round-trips an offset plural, an ordinal, a date skeleton and a select", () => {
    const offset = "{n, plural, offset:1 =0 {nobody} one {you and # other} other {you and # others}}";
    const ordinal = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    const mixed = "{d, date, ::yyyyMMMd} {s, select, a {A} other {{s}}}";
    const catalog = shipped(
      "en",
      [offset, ordinal, mixed].map((source) => ({ source, translation: "" }))
    );
    const { t } = createIntl({ locale: "en", catalog, timeZone: "UTC" });

    expect([
      t(offset, { n: 3 }),
      t(ordinal, { n: 22 }),
      t(mixed, { d: new Date(Date.UTC(2026, 2, 5)), s: "x" }),
    ]).toEqual(["you and 2 others", "22nd", "Mar 5, 2026 x"]);
  });
});

// Unit under test: the English-marker entries of a complete catalog (R2-2), after a JSON round trip. Oracle: Intl's
// en and fi number formats.
describe("a locale's complete catalog", () => {
  const source = "{n, number} orders";

  it("formats a missing Finnish translation in English", () => {
    const intl = createIntl({
      locale: "fi",
      catalog: shipped("fi", [{ source, translation: "" }]),
      timeZone: "UTC",
    });

    expect(intl.t(source, { n: 1234.5 })).toBe("1,234.5 orders");
  });

  it("formats a Finnish translation equal to the source in Finnish", () => {
    const intl = createIntl({
      locale: "fi",
      catalog: shipped("fi", [{ source, translation: source }]),
      timeZone: "UTC",
    });

    expect(intl.t(source, { n: 1234.5 })).toBe("1 234,5 orders");
  });
});

// Unit under test: wire keys. Oracle: a colliding pair found by search, pinned here.
describe("keys", () => {
  it("fails two messages that share a wire key", () => {
    expect(hashKey("Order 577786")).toBe(hashKey("Order 634976"));
    expect(
      problems("en", [
        { source: "Order 577786", translation: "" },
        { source: "Order 634976", translation: "" },
      ])
    ).toEqual([expect.objectContaining({ key: "Order 634976", pass: "collision" })]);
  });

  // A change detector on purpose: every compiled catalog is keyed by hashKey, so changing it must bump
  // SERIALIZER_VERSION in the same change (message.ts), and this pins the two together.
  it("pins the hash to the serializer version", () => {
    expect([SERIALIZER_VERSION, hashKey("Hello"), hashKey("verb\u0004Open")]).toEqual([
      "1",
      "hegfcxe",
      "1kde5ci",
    ]);
  });
});

// Unit under test: loadCatalog, the floor for Node scripts and tests. Oracle: Intl's nb and en number formats, and the
// file's absence as a value (no throw).
describe("loadCatalog", () => {
  const source = "{n, number} items";

  it("compiles a PO file for its basename's locale, or for en when asked, and reports a missing one as a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "elmera-intl-load-"));
    try {
      const path = join(dir, "nb.po");
      writeFileSync(path, po("nb", [{ source, translation: "{n, number} varer" }]));
      const render = (locale: string, result: ReturnType<typeof loadCatalog>) =>
        result._tag === "Compiled"
          ? createIntl({ locale, catalog: result.catalog, timeZone: "UTC" }).t(source, { n: 1234.5 })
          : result.message;

      expect([render("nb", loadCatalog(path)), render("en", loadCatalog(path, "en"))]).toEqual([
        "1\u00a0234,5 varer",
        "1,234.5 items",
      ]);
      expect(loadCatalog(join(dir, "missing.po"))).toMatchObject({
        _tag: "CatalogCompileError",
        locale: "missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
