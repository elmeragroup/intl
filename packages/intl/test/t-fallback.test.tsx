// The fallback of #99. Where the walk meets a problem or the message fails to format, a T element reports once and
// renders its children as written, and the standalone components it then renders show only text the developer wrote.

import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { IntlProvider, Plural, Select, T, Val } from "@elmeragroup/intl/react";

import { compiled, english } from "./catalogs";

const OSLO = "Europe/Oslo";

function render(locale: string, catalog: Catalog, node: ReactNode): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} catalog={catalog} timeZone={OSLO}>
      {node}
    </IntlProvider>
  );
}

/** A render under nb with a recording `onError`: its HTML, and each report as its message and key. */
type Reported = readonly [string, ReadonlyArray<readonly [string, string]>];

function renderReported(catalog: Catalog, node: ReactNode): Reported {
  const reports: Array<readonly [string, string]> = [];
  const html = renderToStaticMarkup(
    <IntlProvider
      locale="nb"
      catalog={catalog}
      timeZone={OSLO}
      onError={(error, key) => reports.push([error.message, key])}>
      {node}
    </IntlProvider>
  );

  return [html, reports];
}

// Unit under test: the standalone components, which a <T> fallback renders. Oracle: each one's documented contract,
// text the developer wrote or nothing, written out per row: `Val` a string or number value prop, `Select` the case
// its value names else `other`, `Plural` the form its count selects, each skipping a part that is not a string.
describe("<Val>, <Plural> and <Select> outside <T>", () => {
  const instant = new Date("2026-01-01T00:00:00Z");

  it.each([
    // @ts-expect-error an untyped caller's null
    ["a null <Val>", <Val v={null} />, ""],
    // @ts-expect-error an untyped caller's undefined
    ["an undefined <Val>", <Val v={undefined} />, ""],
    // @ts-expect-error an untyped caller's object
    ["an object <Val>", <Val v={{ a: 1 }} />, ""],
    // @ts-expect-error an untyped caller's Date
    ["a Date <Val>", <Val v={instant} />, ""],
    // @ts-expect-error an untyped caller's boolean
    ["a boolean <Val>", <Val v={true} />, ""],
    ["a <Val> with children", <Val v="a">b</Val>, "a"],
    ["a <Select> branch spelling other", <Select k="other" _other="A" other="O" />, "O"],
    ["a <Select> branch that is no select key", <Select k="a-b" _a-b="A" other="O" />, "O"],
    // @ts-expect-error an untyped caller's number branch
    ["a number <Select> branch", <Select k="a" _a={1} other="O" />, "O"],
    // @ts-expect-error an untyped caller's element branch
    ["an element <Select> branch", <Select k="a" _a={<b>A</b>} other="O" />, "O"],
    // @ts-expect-error an untyped caller's object branch
    ["an object <Select> branch", <Select k="a" _a={{ x: 1 }} other="O" />, "O"],
    // @ts-expect-error an untyped caller's object other
    ["an object <Select> other", <Select k="b" _a="A" other={{ x: 1 }} />, ""],
    // @ts-expect-error an untyped caller's number form
    ["a number <Plural> form", <Plural n={1} one={1} other="# xs" />, "1 xs"],
  ] as const)("renders %s as text the developer wrote, or nothing", (_label, el, html) => {
    expect(render("en", english(), el)).toBe(html);
  });
});

describe("<T> on children its walk rejects", () => {
  // Unit under test: <T>'s walk, on children the extractor rejects or the types rule out (an untyped value). Oracle:
  // the children as written, each component rendering the part the developer wrote by its documented rule, and one
  // report per render naming the fix (the message each site threw before #99) under the message's key, written out:
  // a malformed component adds nothing to the key, a well-formed one with a value of the wrong kind keeps its
  // argument.
  const instant = new Date("2026-01-01T00:00:00Z");
  it.each([
    [
      "a <Val> named like a positional tag",
      <T>
        <Val x0="Ada" /> read <a href="/t">terms</a>
      </T>,
      'Ada read <a href="/t">terms</a>',
      [
        [
          "argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it",
          "{x0} read <x0>terms</x0>",
        ],
      ],
    ],
    [
      "one <Val> name with two values",
      <T>
        <Val n="1" /> of <Val n="2" />
      </T>,
      "1 of 2",
      [["argument `n` has two values in one <T>; give each value its own name", "{n} of {n}"]],
    ],
    [
      "a <Select> named like a positional tag",
      <T>
        <Select x0="a" _a="Ada" other="someone" /> read <b>terms</b>
      </T>,
      "Ada read <b>terms</b>",
      [
        [
          "argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it",
          "{x0, select, a {Ada} other {someone}} read <x0>terms</x0>",
        ],
      ],
    ],
    [
      "a <Plural> named like a positional tag",
      <T>
        <Plural x0={2} one="# item" other="# items" /> in <b>cart</b>
      </T>,
      "2 items in <b>cart</b>",
      [
        [
          "argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it",
          "{x0, plural, one {# item} other {# items}} in <x0>cart</x0>",
        ],
      ],
    ],
    [
      "a <Plural> form that is not text",
      <T>
        Got {/* @ts-expect-error a form is a string literal */}
        <Plural n={1} one={1} other="#" />
      </T>,
      "Got 1",
      [["<Plural one> needs a string literal form", "Got"]],
    ],
    [
      "a <Select> branch that is no select key",
      <T>
        Got <Select k="a" _a-b="A" other="O" />
      </T>,
      "Got O",
      [
        [
          "<Select> branch `_a-b` is no select key; use `_` and a key without white space or ICU syntax",
          "Got",
        ],
      ],
    ],
    [
      "a <Select> branch spelling other",
      <T>
        Got <Select k="a" _other="A" other="O" />
      </T>,
      "Got O",
      [["<Select> branch `_other` duplicates `other`; write `other`", "Got"]],
    ],
    [
      "a <Select> branch that is not text",
      <T>
        Got {/* @ts-expect-error a branch is a string literal */}
        <Select k="a" _a={1} other="O" />
      </T>,
      "Got O",
      [["<Select _a> needs a string literal branch", "Got"]],
    ],
    [
      "a <Select> without other, its value named",
      <T>
        Got {/* @ts-expect-error other is required */}
        <Select k="a" _a="A" />
      </T>,
      "Got A",
      [["<Select> needs an `other` branch", "Got"]],
    ],
    [
      "a <Select> without other, its value not named",
      <T>
        Got {/* @ts-expect-error other is required */}
        <Select k="b" _a="A" />
      </T>,
      "Got ",
      [["<Select> needs an `other` branch", "Got"]],
    ],
    [
      "a <Val> with two value props",
      <T>
        Got <Val a="1" b="2" />
      </T>,
      "Got 12",
      [["<Val> needs exactly one value prop, got a, b", "Got"]],
    ],
    [
      "a <Val> with no value prop",
      <T>
        Got <Val />
      </T>,
      "Got ",
      [["<Val> needs exactly one value prop, got none", "Got"]],
    ],
    [
      "a <Select> with two value props",
      <T>
        Got <Select k="a" kind="b" other="O" />
      </T>,
      "Got O",
      [["<Select> needs exactly one value prop, got k, kind", "Got"]],
    ],
    [
      "a <Select> with no value prop",
      <T>
        Got <Select _a="A" other="O" />
      </T>,
      "Got O",
      [["<Select> needs exactly one value prop, got none", "Got"]],
    ],
    [
      "a <Plural> with two counts",
      <T>
        Got <Plural n={1} m={2} one="# x" other="# xs" />
      </T>,
      "Got 1 x",
      [["<Plural> needs exactly one value prop, got n, m", "Got"]],
    ],
    [
      "a <Plural> with no count",
      <T>
        Got <Plural one="# x" other="# xs" />
      </T>,
      "Got ",
      [["<Plural> needs exactly one value prop, got none", "Got"]],
    ],
    [
      "an object <Val>",
      <T>
        Got {/* @ts-expect-error an untyped caller's object */}
        <Val v={{ a: 1 }} />
      </T>,
      "Got ",
      [["<Val v> needs a string or number value", "Got {v}"]],
    ],
    [
      "a Date <Val>",
      <T>
        Got {/* @ts-expect-error an untyped caller's Date */}
        <Val v={instant} />
      </T>,
      "Got ",
      [["<Val v> needs a string or number value", "Got {v}"]],
    ],
    [
      "a boolean <Val>",
      <T>
        Got {/* @ts-expect-error an untyped caller's boolean */}
        <Val v={true} />
      </T>,
      "Got ",
      [["<Val v> needs a string or number value", "Got {v}"]],
    ],
    [
      "a bigint <Val>",
      <T>
        Got {/* @ts-expect-error an untyped caller's bigint */}
        <Val v={5n} />
      </T>,
      "Got ",
      [["<Val v> needs a string or number value", "Got {v}"]],
    ],
    [
      "an array <Val>",
      <T>
        Got {/* @ts-expect-error an untyped caller's array */}
        <Val v={["a"]} />
      </T>,
      "Got ",
      [["<Val v> needs a string or number value", "Got {v}"]],
    ],
    [
      "a null <Plural> count",
      <T>
        Got {/* @ts-expect-error an untyped caller's null */}
        <Plural n={null} one="# x" other="# xs" />
      </T>,
      "Got ",
      [["<Plural n> needs a string or number value", "Got {n, plural, one {# x} other {# xs}}"]],
    ],
    [
      "a null <Select> value",
      <T>
        Got {/* @ts-expect-error an untyped caller's null */}
        <Select k={null} _a="A" other="O" />
      </T>,
      "Got O",
      [["<Select k> needs a string or number value", "Got {k, select, a {A} other {O}}"]],
    ],
    [
      "a null <Select> value with a branch that is not text",
      <T>
        Got {/* @ts-expect-error an untyped caller's null, and a branch that is not a string literal */}
        <Select k={null} _a={1} other="O" />
      </T>,
      "Got O",
      [["<Select k> needs a string or number value", "Got"]],
    ],
    [
      "a reserved name before a <Select> without other",
      <T>
        Got <Val x0="a" /> {/* @ts-expect-error other is required */}
        <Select k="a" _a="A" />
      </T>,
      "Got a A",
      [["argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it", "Got {x0}"]],
    ],
  ] as const)("renders %s untranslated and reports it", (_label, el, html, reports) => {
    expect(renderReported(english(), el)).toEqual([html, reports]);
  });

  // Unit under test: a present null or undefined <Val> (an untyped caller's), which ends as t() ends for the same
  // value. Oracle: t.from on the same catalog with { v: null } / { v: undefined } (written out: `Fikk `, and `Fikk N`
  // for null through a select) and the README's rule that a present null or undefined renders as nothing.
  it.each([
    [
      "a null <Val>",
      compiled("nb", { "Got {v}": "Fikk {v}" }),
      <T>
        Got {/* @ts-expect-error an untyped caller's null */}
        <Val v={null} />
      </T>,
      "Fikk ",
    ],
    [
      "an undefined <Val>",
      compiled("nb", { "Got {v}": "Fikk {v}" }),
      <T>
        Got {/* @ts-expect-error an untyped caller's undefined */}
        <Val v={undefined} />
      </T>,
      "Fikk ",
    ],
    [
      "a null <Val> a translation reads as a select",
      compiled("nb", { "Got {v}": "Fikk {v, select, null {N} other {O}}" }),
      <T>
        Got {/* @ts-expect-error an untyped caller's null */}
        <Val v={null} />
      </T>,
      "Fikk N",
    ],
    [
      "a null <Val> named __proto__ a translation reads as a select",
      compiled("nb", { "Got {__proto__}": "Fikk {__proto__, select, null {N} other {O}}" }),
      <T>
        Got {/* @ts-expect-error an untyped caller's null */}
        <Val {...{ ["__proto__"]: null }} />
      </T>,
      "Fikk N",
    ],
  ] as const)("translates %s as t() does, unreported", (_label, catalog, el, html) => {
    expect(renderReported(catalog, el)).toEqual([html, []]);
  });

  // Unit under test: a report whose onError throws, from <T>. Oracle: t(), whose throwing onError propagates its
  // value; a <T> that caught it and rendered the fallback would break strict mode's guarantee (strict.tsx).
  it.each([
    [
      "a format failure",
      compiled("nb", { "Got{n}": "Fikk{n}" }),
      <T>
        Got
        {/* @ts-expect-error an untyped caller's number */}
        <Val n={1234} />
      </T>,
    ],
    [
      "a walk problem",
      english(),
      <T>
        Got {/* @ts-expect-error an untyped caller's object */}
        <Val v={{ a: 1 }} />
      </T>,
    ],
  ] as const)("propagates what a throwing onError throws from <T>: %s", (_label, catalog, el) => {
    const sentinel = new Error("onError threw");
    let thrown: unknown;

    try {
      renderToStaticMarkup(
        <IntlProvider
          locale="nb"
          catalog={catalog}
          timeZone={OSLO}
          onError={() => {
            throw sentinel;
          }}>
          {el}
        </IntlProvider>
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
  });
});

// Unit under test: <T> on a message that fails to format. Oracle: the children as written, and
// PlainArgumentNotText's message and the message's key, written out.
describe("<T> on a message that fails to format", () => {
  // On a translated catalog, so `Got1234` is the English children, not the translation.
  it("renders a number <Val> from <T>'s source as written and reports it", () => {
    expect(
      renderReported(
        compiled("nb", { "Got{n}": "Fikk{n}" }),
        <T>
          Got
          {/* @ts-expect-error <Val> takes text; an untyped caller's number */}
          <Val n={1234} />
        </T>
      )
    ).toEqual([
      "Got1234",
      [['argument "n" got a number: plain {n} takes text; use {n, number} or {n, date}', "Got{n}"]],
    ]);
  });

  // check rejects this translation (ArgumentKindMismatch); <T> renders its children, the count shown by its form.
  it("renders a <Plural> as written and reports it when a translation shows its count plainly", () => {
    expect(
      renderReported(
        compiled("nb", { "Got {n, plural, one {# x} other {# xs}}": "Fikk {n}" }),
        <T>
          Got <Plural n={2} one="# x" other="# xs" />
        </T>
      )
    ).toEqual([
      "Got 2 xs",
      [
        [
          'argument "n" got a number: plain {n} takes text; use {n, number} or {n, date}',
          "Got {n, plural, one {# x} other {# xs}}",
        ],
      ],
    ]);
  });
});
