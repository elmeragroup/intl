import { describe, expect, it } from "vitest";

import type { PoEntry } from "../../src/po";
import { formatPo, parsePo } from "../../src/po";
import recording from "./po-parser-2.2.0.json" with { type: "json" };
import type { Catalog, Entry } from "./po-parser-shape.ts";
import POParser from "./po-parser-shape.ts";

// Unit under test: the PoText codec, and parsePo/formatPo over it. Oracle: po-parser-2.2.0.json, recorded with
// po-parser 2.2.0 and GNU msgcat 1.0, per input:
// - `parsed`/`throws` and `serialized`: po-parser 2.2.0 itself;
// - `dialect`, only where it differs from `parsed`/`throws`: po-parser on the GNU msgcat entries `parsePo` rewrote its
//   input to (`toParserDialect`), the reader the codec replaces;
// - `current`: what `parsePo` returned;
// - `msgcat`: GNU msgcat 1.0's output (for the `gnu` inputs, on the input with a UTF-8 charset header, `msgcat.input`,
//   and `msgcat.entries`, its active entries: GNU msgattrib --no-obsolete over that output, read by po-parser 2.2.0).
//   The `gnu (c-format)` inputs repeat the ones that flag `ignore-same`, which msgcat drops, with a flag it keeps.

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
  "gnu (c-format): obsolete entry ends at a blank line",
  "gnu (c-format): two entries without a blank line",
  "gnu (c-format): flag after the last entry",
  "gnu (c-format): two flag lines",
]);

type Outcome = { readonly parsed: Catalog } | { readonly throws: string };

type Recording = {
  readonly parse: ReadonlyArray<
    {
      readonly name: string;
      readonly input: string;
      readonly dialect?: Outcome;
      readonly msgcat: {
        readonly status: number;
        readonly stdout: string;
        readonly entries?: ReadonlyArray<Entry>;
      };
    } & ({ readonly parsed: Catalog; readonly serialized: string } | { readonly throws: string }) & {
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

// The active entries as GNU msgcat keeps them: the flags it knows (`fuzzy`, `*-format`; it drops others such as
// `ignore-same`), in code-point order, which its output does not keep.
function asGnuKeepsThem(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return entries.map((entry) => {
    const flags = (entry.flags ?? [])
      .filter((flag) => flag === "fuzzy" || flag.endsWith("-format"))
      .toSorted();
    const { flags: _all, ...rest } = entry;

    return flags.length === 0 ? rest : { ...rest, flags };
  });
}

// Each input decoded once: it reads as parsePo read it (po-parser's reading unless `dialect` records GNU msgcat's), and
// where that is po-parser's reading, it writes back as po-parser wrote it.
describe("reads as parsePo read it, and as po-parser 2.2.0 does unless GNU msgcat's entries win", () => {
  it.each(RECORDED.parse)("$name", (recorded) => {
    const actual = ours(recorded.input);
    const po = poParserOutcome(recorded);

    expect(recorded.dialect !== undefined).toBe(DELIBERATE.has(recorded.name));
    expectOutcome(actual, recorded.dialect ?? po);

    if (recorded.dialect !== undefined) {
      expect(withoutEmptyFlags(actual)).not.toEqual(withoutEmptyFlags(po));
    } else if ("parsed" in actual && "serialized" in recorded) {
      expect(POParser.serialize(actual.parsed)).toBe(recorded.serialized);
    }

    // The `gnu` inputs: each comment and flag belongs to the entry GNU gives it. Oracle: `msgcat.entries`, GNU msgcat
    // 1.0's output with obsolete entries removed by GNU msgattrib and read by po-parser 2.2.0, never by this codec.
    if (recorded.msgcat.entries !== undefined) {
      expect(recorded.msgcat.status).toBe(0);
      expect("parsed" in actual ? asGnuKeepsThem(actual.parsed.messages ?? []) : actual).toEqual(
        asGnuKeepsThem(recorded.msgcat.entries)
      );
    }
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
