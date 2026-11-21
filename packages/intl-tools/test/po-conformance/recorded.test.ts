import { describe, expect, it } from "vitest";

import type { PoEntry } from "../../src/po";
import { formatPo, parsePo } from "../../src/po";
import recording from "./po-parser-2.2.0.json" with { type: "json" };
import type { Catalog } from "./po-parser-shape.ts";
import POParser from "./po-parser-shape.ts";

// Unit under test: the PoText codec, and parsePo/formatPo over it. Oracle: po-parser-2.2.0.json, recorded before
// po-parser was removed, per input:
// - `parsed`/`throws` and `serialized`: po-parser 2.2.0 itself;
// - `dialect`: po-parser on the GNU msgcat entries `parsePo` rewrote its input to (`toParserDialect`), the reader the
//   codec replaces;
// - `current`: what `parsePo` returned;
// - `msgcat`: GNU msgcat 1.0 on the same input, the evidence behind each deliberate difference (README.md).

// The inputs where GNU msgcat's entries, which parsePo read, differ from po-parser's (README.md).
const DELIBERATE = new Set([
  "po-parser test input 17",
  "po-parser test input 19",
  "gnu: obsolete entry ends at a blank line",
  "gnu: obsolete entry between entries, no blank line",
  "gnu: two entries without a blank line",
  "gnu: extracted comment after the last entry",
  "gnu: reference after the last entry",
  "gnu: flag after the last entry",
  "gnu: comment-only block between blank lines",
  "gnu: two flag lines",
  "gnu: header directly followed by an entry",
  "edge: blank line inside a multi-line string",
]);

type Outcome = { readonly parsed: Catalog } | { readonly throws: string };

type Recording = {
  readonly parse: ReadonlyArray<
    { readonly name: string; readonly input: string; readonly dialect: Outcome } & (
      | { readonly parsed: Catalog; readonly serialized: string }
      | { readonly throws: string }
    ) & {
        readonly current:
          | { readonly _tag: "Parsed"; readonly file: unknown }
          | { readonly _tag: "PoParseError"; readonly reason: string };
      }
  >;
  readonly serialize: ReadonlyArray<{
    readonly name: string;
    readonly catalog: Catalog;
    readonly output: string;
  }>;
  readonly formatPo: ReadonlyArray<{
    readonly name: string;
    readonly entries: ReadonlyArray<Omit<PoEntry, "context"> & { readonly context?: string }>;
    readonly output: string;
  }>;
};

const loaded: unknown = recording;
// SAFETY: the committed recording, written by the script README.md names; a field it lacks fails the case reading it.
const RECORDED = loaded as Recording;

// po-parser keeps a `#,` line with no flags as `flags: []`, which the codec reads as no flags: the same file.
function withoutEmptyFlags(outcome: Outcome): Outcome {
  if ("throws" in outcome || outcome.parsed.messages === undefined) {
    return outcome;
  }

  const messages = outcome.parsed.messages.map((entry) => {
    const { flags, ...rest } = entry;

    return flags?.length === 0 ? rest : entry;
  });

  return { parsed: { ...outcome.parsed, messages } };
}

function ours(input: string): Outcome {
  try {
    return { parsed: POParser.parse(input) };
  } catch (error) {
    return { throws: error instanceof Error ? error.message : String(error) };
  }
}

function expectOutcome(actual: Outcome, expected: Outcome): void {
  if ("throws" in expected) {
    expect("throws" in actual ? actual.throws : actual).toEqual(expect.stringContaining(expected.throws));
  } else {
    expect(withoutEmptyFlags(actual)).toEqual(withoutEmptyFlags(expected));
  }
}

function poParserOutcome(recorded: Recording["parse"][number]): Outcome {
  return "throws" in recorded ? { throws: recorded.throws } : { parsed: recorded.parsed };
}

describe("reads as parsePo read it, through toParserDialect and po-parser", () => {
  it.each(RECORDED.parse)("$name", (recorded) => {
    expectOutcome(ours(recorded.input), recorded.dialect);
  });
});

describe("projects onto the entries parsePo returned", () => {
  it.each(RECORDED.parse)("$name", (recorded) => {
    const current = parsePo(recorded.input);
    const before = recorded.current;

    if (current._tag === "PoParseError" || before._tag === "PoParseError") {
      expect([current._tag, current._tag === "PoParseError" ? current.reason : ""]).toEqual([
        before._tag,
        expect.stringContaining(before._tag === "PoParseError" ? before.reason : "parsed"),
      ]);
    } else {
      expect(current).toEqual(before);
    }
  });
});

describe("reads and writes as po-parser 2.2.0 does", () => {
  it.each(RECORDED.parse.filter(({ name }) => !DELIBERATE.has(name)))("$name", (recorded) => {
    expectOutcome(ours(recorded.input), poParserOutcome(recorded));

    if ("serialized" in recorded) {
      expect(POParser.serialize(POParser.parse(recorded.input))).toBe(recorded.serialized);
    }
  });
});

describe("differs from po-parser 2.2.0 where GNU msgcat's entries win", () => {
  it.each(RECORDED.parse.filter(({ name }) => DELIBERATE.has(name)))("$name", (recorded) => {
    expect(withoutEmptyFlags(ours(recorded.input))).not.toEqual(withoutEmptyFlags(poParserOutcome(recorded)));
  });
});

describe("writes as po-parser 2.2.0 serializes", () => {
  it.each(RECORDED.serialize)("$name", ({ catalog, output }) => {
    expect(POParser.serialize(catalog)).toBe(output);
  });
});

describe("formatPo writes as before", () => {
  it.each(RECORDED.formatPo)("$name", ({ entries, output }) => {
    expect(
      formatPo(
        "nb",
        entries.map((entry): PoEntry => ({ ...entry, context: entry.context }))
      )
    ).toBe(output);
  });
});
