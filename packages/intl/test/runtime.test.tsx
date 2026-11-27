import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { Catalog, CreateIntlOptions, Descriptor } from "@elmeragroup/intl/core";
import { createIntl, keyOf, msg, serialize } from "@elmeragroup/intl/core";
import { hashKey } from "@elmeragroup/intl/internal/message";
import { IntlProvider, Select, T, Val, useT } from "@elmeragroup/intl/react";

import { compiled, english } from "./catalogs";
import { fixtures } from "./fixtures";

const OSLO = "Europe/Oslo";

function render(locale: string, catalog: Catalog, node: ReactNode): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} catalog={catalog} timeZone={OSLO}>
      {node}
    </IntlProvider>
  );
}

function fixture(index: number): ReactElement {
  const found = fixtures[index]?.el;

  if (!isValidElement(found)) {
    throw new Error(`fixture ${index} is not an element`);
  }

  return found;
}

// Unit under test: <T>'s runtime key (the catalog lookup it makes, by its wire key) and render. Oracle: the
// hand-written key (hashed by hashKey, which compiled catalogs are keyed by) and HTML per fixture.
describe("<T> fixtures", () => {
  const en = compiled("en", Object.fromEntries(fixtures.map(({ key }) => [key, ""])));

  it.each(fixtures.map((f, i) => [i, f] as const))(
    "#%i keys and renders as written",
    (_i, { el, key, html }) => {
      const keys: Array<string> = [];
      // A lookup tests the entries' own properties (`Object.hasOwn`), which reaches this trap with the wire key.
      const entries = new Proxy<Record<string, never>>(
        {},
        {
          getOwnPropertyDescriptor: (_target, prop) => {
            keys.push(String(prop));

            return undefined;
          },
        }
      );
      render("nb", { ...english(), m: entries }, el);
      expect(keys).toEqual([hashKey(key)]);
      expect(render("en", en, el)).toBe(html);
    }
  );
});

describe("translations", () => {
  const nb = compiled("nb", {
    "Read <x0>this</x0> and <x1>that</x1>": "Les <x1>det</x1> og <x0>dette</x0>",
    "You have {count, plural, =0 {no orders} one {# order} other {# orders}}":
      "Du har {count, plural, =0 {ingen ordrer} one {# ordre} other {# ordrer}}",
    [keyOf("Open", "verb")]: "Åpne",
  });

  it("reorders positional tags", () => {
    expect(render("nb", nb, fixture(7))).toBe('Les <a href="/b">det</a> og <a href="/a">dette</a>');
  });

  it("renders a tag the translation leaves empty without its source children", () => {
    expect(
      render(
        "nb",
        compiled("nb", { "Read <x0>this</x0> and <x1>that</x1>": "Les <x0></x0> og <x1>det</x1>" }),
        fixture(7)
      )
    ).toBe('Les <a href="/a"></a> og <a href="/b">det</a>');
  });

  it("formats plurals in the locale", () => {
    expect(render("nb", nb, fixture(10))).toBe("Du har 2 ordrer");
  });

  it("looks up by context", () => {
    expect(render("nb", nb, fixture(11))).toBe("Åpne");
    expect(render("nb", nb, <T>Open</T>)).toBe("Open");
  });
});

// Unit under test: <Select> inside <T>, rendered in a translated locale through a compiled catalog. Oracle: the key
// a migration tool proposed for this message from an adopting app's next-intl catalog, and next-intl's `no`
// renderings of that message in that catalog (`<info>` here a `<b>`), copied by hand.
describe("<Select>", () => {
  const SELECT_IN_TAG =
    "There are orders sold for this {subject, select, company {company} private {person} other {customer}} <x0>{searchInterval, select, lastWeek {in the last week} lastMonth {in the last month} lastYear {in the last year} other {other}}</x0>.";
  const no = compiled("no", {
    [SELECT_IN_TAG]:
      "Det er solgt ordrer for {subject, select, company {dette selskapet} private {denne personen} other {denne kunden}} <x0>{searchInterval, select, lastWeek {i løpet av den siste uken} lastMonth {i løpet av den siste måneden} lastYear {i løpet av det siste året} other {annet}}</x0>.",
  });

  function Orders({
    subject,
    searchInterval,
  }: {
    readonly subject: string;
    readonly searchInterval: string;
  }) {
    return (
      <T>
        There are orders sold for this{" "}
        <Select subject={subject} _company="company" _private="person" other="customer" />{" "}
        <b>
          <Select
            searchInterval={searchInterval}
            _lastWeek="in the last week"
            _lastMonth="in the last month"
            _lastYear="in the last year"
            other="other"
          />
        </b>
        .
      </T>
    );
  }

  it.each([
    ["lastWeek", "company", "Det er solgt ordrer for dette selskapet <b>i løpet av den siste uken</b>."],
    ["lastWeek", "private", "Det er solgt ordrer for denne personen <b>i løpet av den siste uken</b>."],
    ["lastWeek", "‹other›", "Det er solgt ordrer for denne kunden <b>i løpet av den siste uken</b>."],
    ["lastMonth", "company", "Det er solgt ordrer for dette selskapet <b>i løpet av den siste måneden</b>."],
    ["lastYear", "private", "Det er solgt ordrer for denne personen <b>i løpet av det siste året</b>."],
    ["‹other›", "‹other›", "Det er solgt ordrer for denne kunden <b>annet</b>."],
  ] as const)("renders searchInterval %s, subject %s in no", (searchInterval, subject, html) => {
    expect(render("no", no, <Orders subject={subject} searchInterval={searchInterval} />)).toBe(html);
  });

  it("renders the English branch outside <T>, and other for a value no branch names", () => {
    expect(
      render(
        "en",
        english(),
        <>
          <Select kind="b" _a="A" _b="B" other="O" />|<Select kind="c" _a="A" other="O" />
        </>
      )
    ).toBe("B|O");
  });
});

// Unit under test: a key the catalog lacks (not extracted yet: dev before the watcher's write, a test without a
// catalog). The runtime has no parser, so a structured source renders raw. Oracle: the hand-written raw source, the
// children, and the reported key.
describe("a message missing from the catalog", () => {
  function reported(node: ReactNode) {
    const errors: Array<string> = [];
    const html = renderToStaticMarkup(
      <IntlProvider
        locale="nb"
        catalog={english()}
        timeZone={OSLO}
        onError={(_error, key) => errors.push(key)}>
        {node}
      </IntlProvider>
    );

    return { html, errors };
  }

  function Unextracted(): ReactNode {
    const t = useT();

    return t("Hi {name}", { name: "Ada" });
  }

  it("renders plain text as written, unreported", () => {
    expect(reported(<T>Plain text</T>)).toEqual({ html: "Plain text", errors: [] });
  });

  it("t returns its raw source and reports the key", () => {
    expect(reported(<Unextracted />)).toEqual({ html: "Hi {name}", errors: ["Hi {name}"] });
  });

  it("<T> renders its children and reports the key", () => {
    expect(
      reported(
        <T>
          Hi <Val name="Ada" />
        </T>
      )
    ).toEqual({ html: "Hi Ada", errors: ["Hi {name}"] });
  });
});

describe("components", () => {
  const en = english("Got {one}", "Hello {name}");

  it("renders <Val> outside <T> as its value", () => {
    expect(
      render(
        "en",
        en,
        <b>
          <Val n="5" />
        </b>
      )
    ).toBe("<b>5</b>");
  });

  it('treats <Val one="1" /> as a value named one', () => {
    expect(
      render(
        "en",
        en,
        <T>
          Got <Val one="1" />
        </T>
      )
    ).toBe("Got 1");
  });

  // Row 1: <T>'s walk cannot put these in a message, so <T> throws, reporting nothing (the extractor rejects both too).
  it.each([
    [
      "a promise",
      Promise.resolve("Ada"),
      "<T> child is not text, an element, <Val>, <Plural> or <Select>: [object Promise]",
    ],
    [
      "an object",
      { a: 1 },
      "<T> child is not text, an element, <Val>, <Plural> or <Select>: [object Object]",
    ],
  ] as const)("rejects a child that is not text or an element: %s", (_label, child, message) => {
    const reports: Array<string> = [];
    const tree = (
      <IntlProvider
        locale="nb"
        catalog={english()}
        timeZone={OSLO}
        onError={(error) => reports.push(error.message)}>
        {/* @ts-expect-error an object is no ReactNode; a promise is one elsewhere, but <T> cannot put it in a message */}
        <T>{child}</T>
      </IntlProvider>
    );
    expect(() => renderToStaticMarkup(tree)).toThrow(message);
    expect(reports).toEqual([]);
  });

  // Unit under test: a <T> written inside a <T>, against a catalog holding the outer message's key, which any
  // `<T context="nest">a <b>b</b> c</T>` provides (positional tags erase the element), and the inner message's. Oracle:
  // the children as written, the inner <T> translated by its own entry, with one report naming the fix, under the outer
  // message's catalog key (context, U+0004, source), written out here; translating would hand the inner <T> the outer
  // translation's text, which it renders as `ABC`.
  it("renders a <T> inside a <T> as written, the inner one translated, and reports it, though the catalog has the outer key", () => {
    const reports: Array<readonly [string, string]> = [];
    const html = renderToStaticMarkup(
      <IntlProvider
        locale="nb"
        catalog={compiled("nb", { "nest\u0004a <x0>b</x0> c": "A<x0> B </x0>C", b: "innermelding" })}
        timeZone={OSLO}
        onError={(error, key) => reports.push([error.message, key])}>
        <T context="nest">
          a <T>b</T> c
        </T>
      </IntlProvider>
    );
    expect([html, reports]).toEqual([
      "a innermelding c",
      [["<T> cannot contain another <T>; keep the whole text in the outer <T>", "nest\u0004a <x0>b</x0> c"]],
    ]);
  });

  it("requires a provider", () => {
    expect(() => renderToStaticMarkup(<T>x</T>)).toThrow("need an <IntlProvider>");
  });

  it("useT formats with values", () => {
    function Hello() {
      const t = useT();

      return <>{t("Hello {name}", { name: "Ada" })}</>;
    }
    expect(render("en", en, <Hello />)).toBe("Hello Ada");
  });
});

// Host TZ is America/Los_Angeles (vitest.config.ts), so these prove the configured zone wins over the host's.
describe("time zone", () => {
  const catalog = english(
    "Order {id}",
    "On {d, date, short}",
    "On {d, date}",
    "On {d, date, ::yyyyMMdd}",
    "At {d, time, ::Hm}"
  );
  const osloIntl = createIntl({ locale: "en", catalog, timeZone: OSLO });
  const lateUtc = new Date("2026-01-01T23:30:00Z");

  it("types t values from the literal", () => {
    expect(osloIntl.t("Order {id}", { id: "42" })).toBe("Order 42");
  });

  it.each([
    ["On {d, date, short}", "On 1/2/26"],
    ["On {d, date}", "On 1/2/2026"],
    ["On {d, date, ::yyyyMMdd}", "On 01/02/2026"],
    ["At {d, time, ::Hm}", "At 00:30"],
  ] as const)("%s formats in the configured zone", (message, expected) => {
    expect(osloIntl.t(message, { d: lateUtc })).toBe(expected);
  });

  it("differs in UTC", () => {
    expect(
      createIntl({ locale: "en", catalog, timeZone: "UTC" }).t("On {d, date, short}", { d: lateUtc })
    ).toBe("On 1/1/26");
  });
});

// Unit under test: what t, t.from and <T> do with each value a plain `{x}` can get. Oracle: hand-written text and
// errors (nb groups with U+00A0 and writes dates d.M.yyyy).
describe("plain arguments take text", () => {
  const lateUtc = new Date("2026-01-01T23:30:00Z");
  const enIntl = createIntl({
    locale: "en",
    catalog: english(
      "Total {n, number}",
      "{n, number} {n, plural, one {item} other {items}}",
      "<x>Hidden</x>",
      "{gender, select, female {She} other {{name}}}",
      "{state, select, pending {Pending} other {Processed on {date, date}}}"
    ),
    timeZone: OSLO,
  });
  const nbIntl = createIntl({
    locale: "nb",
    catalog: compiled("nb", { "Total {n, number}": "Totalt {n, number}", "On {d, date}": "Den {d, date}" }),
    timeZone: OSLO,
  });

  it.each([
    ["a number", msg("Total {n, number}"), { n: 1234567.5 }, "Total 1,234,567.5"],
    ["zero", msg("Total {n, number}"), { n: 0 }, "Total 0"],
    [
      "a number formatted and used as a plural",
      msg("{n, number} {n, plural, one {item} other {items}}"),
      { n: 1000 },
      "1,000 items",
    ],
  ] as const)("t.from: %s", (_label, descriptor, values, expected) => {
    expect(enIntl.t.from(descriptor, values)).toBe(expected);
  });

  it("formats in the translation's locale and the configured zone", () => {
    expect([
      nbIntl.t.from(msg("Total {n, number}"), { n: 1234567.5 }),
      nbIntl.t.from(msg("On {d, date}"), { d: lateUtc }),
    ]).toEqual(["Totalt 1\u00A0234\u00A0567,5", "Den 2.1.2026"]);
  });

  // An instance that records each report as its message and key.
  const recording = (locale: string, catalog: Catalog) => {
    const reports: Array<readonly [string, string]> = [];
    const intl = createIntl({
      locale,
      catalog,
      timeZone: OSLO,
      onError: (reported, key) => reports.push([reported.message, key]),
    });

    return { intl, reports };
  };

  // A widened descriptor's values are untyped, as any cast or `any` caller's are. Each reports once under the
  // message's key, then t throws what it reported.
  it.each([
    ["a number", 1000, 'argument "n" got a number: plain {n} takes text; use {n, number} or {n, date}'],
    ["a Date", lateUtc, 'argument "n" got a Date: plain {n} takes text; use {n, number} or {n, date}'],
    ["an object", { a: 1 }, 'argument "n" got a object: plain {n} takes text; use {n, number} or {n, date}'],
    ["a boolean", true, 'argument "n" got a boolean: plain {n} takes text; use {n, number} or {n, date}'],
  ] as const)("reports %s in a plain translation argument, then throws it", (_label, value, error) => {
    const { intl, reports } = recording("nb", compiled("nb", { "Total {n}": "Totalt {n}" }));
    const untyped: Descriptor = msg("Total {n}");
    // @ts-expect-error an object and a boolean are no message values; an untyped caller passes them anyway
    expect(() => intl.t.from(untyped, { n: value })).toThrow(error);
    expect(reports).toEqual([[error, "Total {n}"]]);
  });

  // check rejects this translation (ArgumentKindMismatch); with no English catalog to fall back to, a shipped one
  // reports, then throws, like any caller bug.
  it("reports, then throws, when a translation shows a number plainly", () => {
    const reports: Array<string> = [];
    const translatedIntl = createIntl({
      locale: "nb",
      catalog: compiled("nb", { "Total {n, number}": "Totalt {n}" }),
      timeZone: OSLO,
      onError: (reported) => reports.push(reported.message),
    });
    const error = 'argument "n" got a number: plain {n} takes text; use {n, number} or {n, date}';
    expect(() => translatedIntl.t("Total {n, number}", { n: 1000 })).toThrow(error);
    expect(reports).toEqual([error]);
  });

  it("renders a present null or undefined from an untyped caller as nothing, unreported", () => {
    const { intl, reports } = recording("en", english("[{v}|{w}]"));
    const values = Object.fromEntries([
      ["v", null],
      ["w", undefined],
    ]);
    // @ts-expect-error null and undefined are not message values; an untyped caller still gets text
    expect([intl.t.from(msg("[{v}|{w}]"), values), reports]).toEqual(["[|]", []]);
  });

  it("never calls a function value (tag renderers are <T>'s alone)", () => {
    const seen: Array<string> = [];
    const renderTag = (parts: Array<string>) => {
      seen.push(...parts);

      return "";
    };
    // @ts-expect-error t's values are message values; an untyped caller's function must not be called
    expect(() => enIntl.t.from(msg("<x>Hidden</x>"), { x: renderTag })).toThrow();
    expect(seen).toEqual([]);
  });

  // The report is intl-messageformat's MissingValueError, which the plain argument's getter builds with no message.
  it("names a missing plain argument by its own name, and reports it", () => {
    const { intl, reports } = recording("en", english("Hi {name}"));
    // @ts-expect-error the value is missing on purpose
    expect(() => intl.t("Hi {name}", {})).toThrow('"name"');
    expect(reports).toEqual([
      ['The intl string context variable "name" was not provided to the string "undefined"', "Hi {name}"],
    ]);
  });

  it("does not require an argument in an unselected ICU branch", () => {
    expect(enIntl.t("{gender, select, female {She} other {{name}}}", { gender: "female" })).toBe("She");
  });

  it("does not format a value only an unselected branch uses", () => {
    // An invalid Date throws RangeError when formatted.
    expect(
      enIntl.t("{state, select, pending {Pending} other {Processed on {date, date}}}", {
        state: "pending",
        date: new Date(""),
      })
    ).toBe("Pending");
  });

  it("names a missing plain argument of the selected branch by its own name", () => {
    // @ts-expect-error the selected branch's name is missing on purpose
    expect(() => enIntl.t("{gender, select, female {She} other {{name}}}", { gender: "other" })).toThrow(
      '"name"'
    );
  });
});

// Unit under test: `serialize` (`/core`), the key every plural message is looked up by. Oracle: the key written out
// here: exact forms first in numeric order (=2 before =12), then the CLDR categories alphabetically, whatever the
// props' order, as compiled catalogs were keyed before this ran on an ES2022 engine (#41).
describe("the serializer on an ES2022 engine", () => {
  it("keys a plural without Array.prototype.toSorted (ES2023)", () => {
    const nodes = [
      { kind: "text", text: "You have " },
      {
        kind: "plural",
        name: "count",
        forms: {
          other: "# orders",
          _12: "a dozen orders",
          one: "# order",
          zero: "none",
          _2: "a pair",
          few: "# few",
        },
      },
    ] as const;
    const toSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    let key: string;
    try {
      // An ES2022 engine's Array.prototype, only around the call under test: the runner may use `toSorted`.
      Reflect.deleteProperty(Array.prototype, "toSorted");
      expect("toSorted" in Array.prototype, "Array.prototype.toSorted is gone").toBe(false);
      key = serialize(nodes);
    } finally {
      if (toSorted !== undefined) {
        // oxlint-disable-next-line no-extend-native -- puts back the engine's own `toSorted`, by its saved descriptor
        Object.defineProperty(Array.prototype, "toSorted", toSorted);
      }
    }

    expect(key).toBe(
      "You have {count, plural, =2 {a pair} =12 {a dozen orders} few {# few} one {# order} other {# orders} zero {none}}"
    );
  });
});

// `console.error`, spied for one test and restored after it, with what the spy does instead.
function spyConsoleError(implementation: (...args: Array<unknown>) => void) {
  const consoleError = vi.spyOn(console, "error").mockImplementation(implementation);
  onTestFinished(() => {
    consoleError.mockRestore();
  });

  return consoleError;
}

// Unit under test: what a report reaches with no onError, and that a handler replaces it. Oracle: the runtime's
// default as the contract states it (`console.error("@elmeragroup/intl:", JSON.stringify(key), error)`, once per key
// and message in a loaded runtime), and each report's key, which for a message with no context is its source. Every
// source and format name here is used by no other test in this file: what the default has logged persists within it.
describe("reports with no onError", () => {
  const nowhere = english();

  it("logs each distinct problem once, across instances, and nothing when a handler is given", () => {
    const consoleError = spyConsoleError(() => undefined);
    const handled: Array<string> = [];
    const firstIntl = createIntl({ locale: "en", catalog: nowhere, timeZone: OSLO });
    // A catalog of its own with the same contents, so a history kept per catalog would log its problem again.
    const secondIntl = createIntl({ locale: "en", catalog: english(), timeZone: OSLO });
    const thirdIntl = createIntl({ locale: "en", catalog: nowhere, timeZone: OSLO });
    const handledIntl = createIntl({
      locale: "en",
      catalog: nowhere,
      timeZone: OSLO,
      onError: (_error, key) => handled.push(key),
    });
    const date = new Date("2026-03-05T12:00:00Z");

    expect([
      firstIntl.t("Unextracted {who} reaches the console", { who: "Ada" }),
      secondIntl.t("Unextracted {who} reaches the console", { who: "Ada" }),
      thirdIntl.t("A second {what} reaches the console", { what: "problem" }),
      thirdIntl.format.dateTime(date, "reportFirstName"),
      thirdIntl.format.dateTime(date, "reportSecondName"),
      handledIntl.t("Handled {who} stays off the console", { who: "Ada" }),
      handledIntl.t("Handled {who} stays off the console", { who: "Ada" }),
    ]).toEqual([
      "Unextracted {who} reaches the console",
      "Unextracted {who} reaches the console",
      "A second {what} reaches the console",
      String(date),
      String(date),
      "Handled {who} stays off the console",
      "Handled {who} stays off the console",
    ]);
    expect(consoleError.mock.calls.map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"Unextracted {who} reaches the console"'],
      ["@elmeragroup/intl:", '"A second {what} reaches the console"'],
      ["@elmeragroup/intl:", '"format.dateTime"'],
      ["@elmeragroup/intl:", '"format.dateTime"'],
    ]);
    expect(consoleError.mock.calls[0]?.[2]).toMatchObject({
      _tag: "MessageNotExtracted",
      source: "Unextracted {who} reaches the console",
    });
    expect(consoleError.mock.calls.slice(2).map((call: ReadonlyArray<unknown>) => call[2])).toMatchObject([
      { _tag: "FormatNotFound", format: "reportFirstName" },
      { _tag: "FormatNotFound", format: "reportSecondName" },
    ]);
    expect(handled).toEqual(["Handled {who} stays off the console", "Handled {who} stays off the console"]);

    // The same missing name through another method: the same message under another key, so a record kept by message
    // alone would drop it.
    thirdIntl.format.dateTimeRange(date, date, "reportFirstName");
    expect(consoleError.mock.calls.slice(4).map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"format.dateTimeRange"'],
    ]);
    expect(consoleError.mock.calls[4]?.[2]).toMatchObject({
      _tag: "FormatNotFound",
      format: "reportFirstName",
    });
  });

  // A JavaScript app passes `onError: enabled ? report : null`, which the types rule out. Oracle: origin/main, where a
  // null handler was skipped and the fallback rendered; it now gets the default, as an absent one does.
  it("renders the fallback and logs through the default when onError is null", () => {
    const consoleError = spyConsoleError(() => undefined);
    const options: CreateIntlOptions = { locale: "en", catalog: nowhere, timeZone: OSLO };
    // A JavaScript caller's null, set past the option's type, which rules it out.
    Reflect.set(options, "onError", null);
    const intl = createIntl(options);

    expect([
      intl.t("Null onError {who} falls back", { who: "Ada" }),
      intl.t("Null onError {who} falls back", { who: "Ada" }),
    ]).toEqual(["Null onError {who} falls back", "Null onError {who} falls back"]);
    expect(consoleError.mock.calls.map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"Null onError {who} falls back"'],
    ]);
  });

  // The fallbacks and the thrown error are origin/main's, where no report reached the console.
  it("renders and throws as without it when the console throws", () => {
    const consoleThrew = new Error("the console is broken");
    const consoleError = spyConsoleError(() => {
      throw consoleThrew;
    });
    const translatedIntl = createIntl({
      locale: "nb",
      catalog: compiled("nb", { "Sum {s, number} when the console throws": "Sum {s}" }),
      timeZone: OSLO,
    });
    const notExtracted = (
      <T>
        Unextracted <Val who="Ada" /> while the console throws
      </T>
    );
    let thrown: unknown;

    expect([
      render("en", nowhere, notExtracted),
      // Again: the pair was recorded before the console threw, so it is not logged a second time.
      render("en", nowhere, notExtracted),
      translatedIntl.format.number(1234, "reportWhileThrowing"),
    ]).toEqual([
      "Unextracted Ada while the console throws",
      "Unextracted Ada while the console throws",
      "1234",
    ]);
    try {
      translatedIntl.t("Sum {s, number} when the console throws", { s: 1000 });
    } catch (error) {
      thrown = error;
    }
    // The error main throws, by its hand-written message, and the very object that was reported.
    expect(thrown).toMatchObject({
      message: 'argument "s" got a number: plain {s} takes text; use {s, number} or {s, date}',
    });
    expect(thrown).toBe(consoleError.mock.calls[2]?.[2]);
    expect(consoleError).toHaveBeenCalledTimes(3);
  });

  // Unit under test: t() on a formatter that throws a value that is not an Error. Oracle: origin/main, where t()
  // throws the caught value itself and the default reporter logs an Error with its text.
  it("throws a value that is not an Error as itself, and reports it as an Error", () => {
    const consoleError = spyConsoleError(() => undefined);
    const sentinel = "the date's value could not be read";
    // A Date whose value cannot be read: formatting it throws what it was given.
    class ThrowingDate extends Date {
      readonly #thrown: unknown;

      constructor(thrown: string) {
        super(0);
        this.#thrown = thrown;
      }

      override valueOf(): number {
        throw this.#thrown;
      }
    }
    const intl = createIntl({
      locale: "en",
      catalog: english("On {when, date} with a thrown string"),
      timeZone: OSLO,
    });
    let thrown: unknown;

    try {
      intl.t("On {when, date} with a thrown string", { when: new ThrowingDate(sentinel) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(consoleError.mock.calls.map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"On {when, date} with a thrown string"'],
    ]);
    expect(consoleError.mock.calls[0]?.[2]).toMatchObject({ name: "Error", message: sentinel });
  });

  it("throws the formatting error itself when reading its message throws", () => {
    const consoleError = spyConsoleError(() => undefined);
    const unreadable = new Error("replaced by a getter");
    Object.defineProperty(unreadable, "message", {
      get: () => {
        throw new Error("the message getter threw");
      },
    });
    // A Date whose value cannot be read: formatting it throws `unreadable`, as a hostile value would.
    class UnreadableDate extends Date {
      override valueOf(): number {
        throw unreadable;
      }
    }
    const intl = createIntl({
      locale: "en",
      catalog: english("On {when, date} with an unreadable error"),
      timeZone: OSLO,
    });
    let thrown: unknown;

    try {
      intl.t("On {when, date} with an unreadable error", { when: new UnreadableDate() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(unreadable);
    expect(consoleError).toHaveBeenCalledTimes(0);
  });
});
