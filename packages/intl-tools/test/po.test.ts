import { expect, it } from "vitest";

import type { PoEntry } from "../src/po";
import { formatPo, parsePo } from "../src/po";

// Unit under test: the PO writer and reader. Oracle: the entries written must read back unchanged, including the
// characters PO escapes and ICU syntax.
it("round-trips entries with escapes, context, comments, references and flags", () => {
  const entries: ReadonlyArray<PoEntry> = [
    {
      source: 'Say "hi"\\now\nand\ttab',
      context: "verb",
      translation: 'Si "hei"\\nå',
      references: ["src/a.tsx", "src/b.tsx"],
      comments: ["<x0> = <a href>"],
      flags: ["fuzzy"],
    },
    {
      source: "You have {n, plural, one {# order} other {# orders}}",
      context: undefined,
      translation: "",
      references: ["src/c.ts"],
      comments: [],
      flags: [],
    },
  ];
  const parsed = parsePo(formatPo("nb", entries));
  expect(parsed).toEqual({
    _tag: "Parsed",
    file: {
      meta: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Transfer-Encoding": "8bit",
        Language: "nb",
        "X-Elmera-Serializer": "1",
      },
      entries,
    },
  });
});

it("names what it cannot read", () => {
  const parsed = parsePo('msgid "a"\nmsgid_plural "as"\nmsgstr[0] ""\n');
  expect(parsed._tag === "PoParseError" ? parsed.reason : "parsed").toContain("msgid_plural");
});
