import type { Formatters } from "intl-messageformat";
import { IntlMessageFormat } from "intl-messageformat";
import { expect, it } from "vitest";

import type { MessageNode } from "@elmeragroup/intl/core";
import { serialize } from "@elmeragroup/intl/core";

// Unit under test: serialize's ICU escaping. Oracle: IntlMessageFormat itself; every text up to length 5 over the
// ICU syntax chars, serialized in every position, must format back to exactly that text
// (in a plural form, with `#` as the count; in a select branch, `#` as itself).
const ALPHABET = ["a", "'", "{", "}", "<", ">", "#", "|"];
const MAX_LENGTH = 5;

function allStrings(): Array<string> {
  const out: Array<string> = [];
  let previous = [""];
  for (let length = 1; length <= MAX_LENGTH; length += 1) {
    previous = previous.flatMap((prefix) => ALPHABET.map((char) => prefix + char));
    out.push(...previous);
  }

  return out;
}

type Position = {
  readonly name: string;
  readonly nodes: (text: string) => ReadonlyArray<MessageNode>;
  readonly expected: (text: string) => string;
};

const POSITIONS: ReadonlyArray<Position> = [
  { name: "alone", nodes: (s) => [{ kind: "text", text: s }], expected: (s) => s },
  {
    name: "before an argument",
    nodes: (s) => [
      { kind: "text", text: s },
      { kind: "arg", name: "v" },
    ],
    expected: (s) => `${s}X`,
  },
  {
    name: "after an argument",
    nodes: (s) => [
      { kind: "arg", name: "v" },
      { kind: "text", text: s },
    ],
    expected: (s) => `X${s}`,
  },
  {
    name: "inside a tag",
    nodes: (s) => [
      { kind: "el", index: 0, children: [{ kind: "text", text: s }] },
      { kind: "text", text: "z" },
    ],
    expected: (s) => `[${s}]z`,
  },
  {
    // A plural form is literal text where only `#` (the formatted count) is special.
    name: "inside a plural form",
    nodes: (s) => [{ kind: "plural", name: "n", forms: { other: s } }],
    expected: (s) => s.replaceAll("#", "3"),
  },
  {
    // Outside a plural, `#` in a select branch is literal.
    name: "inside a select branch",
    nodes: (s) => [{ kind: "select", name: "v", cases: [["X", s]], other: "o" }],
    expected: (s) => s,
  },
  {
    name: "inside a select's other",
    nodes: (s) => [{ kind: "select", name: "v", cases: [["Y", "y"]], other: s }],
    expected: (s) => s,
  },
];

const STRINGS = allStrings();

// Formatters shared by every message: by default each IntlMessageFormat builds its own Intl objects, which was
// over half the cost.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function cached<T>(cache: Map<string, T>, key: ReadonlyArray<unknown>, create: () => T): T {
  const id = JSON.stringify(key);
  const hit = cache.get(id);

  if (hit !== undefined) {
    return hit;
  }

  const created = create();
  cache.set(id, created);

  return created;
}

const FORMATTERS: Formatters = {
  getNumberFormat: (locales, options) =>
    cached(numberFormats, [locales, options], () => new Intl.NumberFormat(locales, options)),
  getDateTimeFormat: (locales, options) =>
    cached(dateTimeFormats, [locales, options], () => new Intl.DateTimeFormat(locales, options)),
  getPluralRules: (locales, options) =>
    cached(pluralRules, [locales, options], () => new Intl.PluralRules(locales, options)),
};

function roundTrip(message: string): string {
  try {
    const formatted = new IntlMessageFormat(message, "en", undefined, {
      formatters: FORMATTERS,
    }).format<string>({
      v: "X",
      n: 3,
      x0: (chunks) => `[${chunks.join("")}]`,
    });

    return Array.isArray(formatted) ? formatted.join("") : formatted;
  } catch (error) {
    return `THROW ${String(error)}`;
  }
}

// 8 + 8^2 + ... + 8^5: a generator that shrank would let the round trips pass on less.
it("covers every text up to the max length", () => {
  expect(STRINGS).toHaveLength(37_448);
});

// The timeout is a hang guard on deterministic CPU work, not a timing assertion: ~0.1 s locally, sized for a CI agent
// running several suites at once (the whole file once took 7 s there).
it.each(POSITIONS)("round-trips every short text through ICU $name", { timeout: 30_000 }, (position) => {
  const failures: Array<string> = [];
  for (const text of STRINGS) {
    const message = serialize(position.nodes(text));
    const out = roundTrip(message);

    if (out !== position.expected(text)) {
      failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(message)} -> ${JSON.stringify(out)}`);
    }
  }

  expect(failures.slice(0, 6)).toEqual([]);
});
