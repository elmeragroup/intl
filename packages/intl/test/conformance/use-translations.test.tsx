// @vitest-environment jsdom
// Ported from next-intl v4.14.9, packages/use-intl/src/react/useTranslations.test.tsx: its message-formatting cases.
// Each keeps its next-intl name and hand-written expected output verbatim, and runs through createIntl + t with the
// config next-intl's <IntlProvider> gets (or <T> under our <IntlProvider> for rich text). Exclusions and counts:
// README.md here.
//
// MIT License. Copyright (c) 2024 Jan Amann. Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Formats } from "@elmeragroup/intl/core";
import { T } from "@elmeragroup/intl/react";

import { mountStrict, renderStrict, strictIntl } from "./strict";

// What next-intl's renderMessage passes to its provider.
const PROVIDER_FORMATS: Formats = { dateTime: { time: { hour: "numeric", minute: "2-digit" } } };

function translator(options: { readonly formats?: Formats; readonly timeZone?: string } = {}) {
  return strictIntl({
    locale: "en",
    timeZone: options.timeZone ?? "Etc/UTC",
    formats: { ...PROVIDER_FORMATS, ...options.formats },
  }).t;
}

it("handles static messages", () => {
  expect(translator()("Hello")).toBe("Hello");
});

it("handles basic interpolation", () => {
  expect(translator()("Hello {name}", { name: "Jane" })).toBe("Hello Jane");
});

it("can escape curly brackets", () => {
  expect(translator()("Hello '{name}'")).toBe("Hello {name}");
});

it("can can use single quotes", () => {
  expect(translator()("Hello 'name'")).toBe("Hello 'name'");
});

// Ours has no production fast path: every message compiles, in every build.
it("can escape curly brackets in production", () => {
  expect(translator()("Hello '{name}'")).toBe("Hello {name}");
});

it("handles number formatting with percent", () => {
  expect(translator()("{value, number, percent}", { value: 0.312 })).toBe("31%");
});

it("handles number formatting with a static currency", () => {
  expect(translator()("{price, number, ::currency/EUR}", { price: 123394.1243 })).toBe("€123,394.12");
});

it("handles number formatting with defined decimals", () => {
  expect(translator()("{value, number, ::.#}", { value: 123394.1243 })).toBe("123,394.1");
});

// next-intl passes the format per call; ours configures it on the instance.
it("handles number formatting with a custom format", () => {
  const t = translator({ formats: { number: { currency: { style: "currency", currency: "EUR" } } } });

  expect(t("{price, number, currency}", { price: 123394.1243 })).toBe("€123,394.12");
});

it("handles date formatting", () => {
  expect(translator()("{now, date, medium}", { now: new Date("2020-11-19T15:38:43.700Z") })).toBe(
    "Nov 19, 2020"
  );
});

describe("applies a time zone when using a built-in format", () => {
  const now = new Date("2023-05-08T22:50:16.879Z");
  const t = translator();

  it.each([
    ["{now, time, full}", "10:50:16 PM UTC"],
    ["{now, time, long}", "10:50:16 PM UTC"],
    ["{now, time, medium}", "10:50:16 PM"],
    ["{now, time, short}", "10:50 PM"],
    ["{now, date, full}", "Monday, May 8, 2023"],
    ["{now, date, long}", "May 8, 2023"],
    ["{now, date, medium}", "May 8, 2023"],
    ["{now, date, short}", "5/8/23"],
  ] as const)("%s: %s", (message, expected) => {
    expect(t(message, { now })).toBe(expected);
  });
});

it("applies a time zone when using a skeleton", () => {
  const t = translator({ timeZone: "Asia/Kolkata" });

  expect(t("{now, date, ::yyyyMdHm}", { now: new Date("2024-01-01T00:00:00.000+0530") })).toBe(
    "1/1/2024, 00:00"
  );
});

it("supports pluralisation via specific numbers", () => {
  expect(
    translator()("You have {numMessages, plural, =0 {no messages} =1 {one message} other {# messages}}.", {
      numMessages: 1,
    })
  ).toBe("You have one message.");
});

// next-intl's message is Latvian; here it is the lv translation of an English source, so it formats in lv.
it('supports pluralisation via tags like "zero" and "one" if the locale supports it', () => {
  const source = "You have {count, plural, one {one follower} other {# followers}}.";
  const { t } = strictIntl({
    locale: "lv",
    timeZone: "Etc/UTC",
    translations: {
      [source]: "Jums ir {count, plural, zero {vēl nav sekotāju} one {viens sekotājs} other {# sekotāji}}.",
    },
  });

  expect(t(source, { count: 0 })).toBe("Jums ir vēl nav sekotāju.");
});

it("handles selects", () => {
  expect(
    translator()("{gender, select, male {He is} female {She is} other {They are}} online.", {
      gender: "female",
    })
  ).toBe("She is online.");
});

it("handles selectordinals", () => {
  expect(
    translator()("It's my cat's {year, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} birthday!", {
      year: 21,
    })
  ).toBe("It's my cat's 21st birthday!");
});

it("can use messages in attributes", () => {
  expect(translator()("https://example.com")).toBe("https://example.com");
});

it("allows empty messages", () => {
  expect(translator()("")).toBe("");
});

// Deliberate difference D1: a plain `{x}` takes text only. next-intl renders the number as String(n)
// ("[Cache test] Render #1"); ours rejects it (the types first, then the runtime for an untyped caller).
it("utilizes a cache for parsing messages", () => {
  const t = translator();

  // @ts-expect-error -- D1: a number in a plain {renderNum}
  expect(() => t("[Cache test] Render #{renderNum}", { renderNum: 1 })).toThrow(
    'argument "renderNum" got a number: plain {renderNum} takes text; use {renderNum, number} or {renderNum, date}'
  );
});

// next-intl's messages use tag renderers (`<important>`, `<bold>`); <T> writes the same messages as JSX.
describe("t.rich", () => {
  const config = { locale: "en", timeZone: "Europe/London", formats: PROVIDER_FORMATS } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles rich text", () => {
    expect(
      renderStrict(
        <T>
          This is <b>important</b> and <b>this as well</b>
        </T>,
        config
      )
    ).toBe("This is <b>important</b> and <b>this as well</b>");
  });

  it("handles nested rich text", () => {
    expect(
      renderStrict(
        <T>
          This is{" "}
          <b>
            <i>very</i> important
          </b>
        </T>,
        config
      )
    ).toBe("This is <b><i>very</i> important</b>");
  });

  // React reports duplicate or missing keys through console.error while reconciling, which only client rendering
  // does, so its silence under createRoot is the observable.
  it("supports identical wrappers with identical text content", () => {
    const consoleError = vi.spyOn(console, "error");
    const html = mountStrict(
      <T>
        <b>foo</b> bar <b>foo</b> <i>foo</i> bar <i>foo</i>{" "}
        <b>
          <i>foobar</i>
        </b>
      </T>,
      config
    );

    expect(html).toBe("<b>foo</b> bar <b>foo</b> <i>foo</i> bar <i>foo</i> <b><i>foobar</i></b>");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// Per-call formats are not part of our API: "allows to override global formats locally" configures the formats
// next-intl merges for the call (global, then the call's) on the instance.
describe("global formats", () => {
  // next-intl's provider here has no zone, so it formats in the suite's TZ.
  function renderDate(formats: Formats) {
    return strictIntl({ locale: "en", timeZone: "Europe/Berlin", formats }).t;
  }

  const value = new Date("2020-11-19T15:38:43.700Z");

  it("allows to add global formats", () => {
    const t = renderDate({ dateTime: { onlyYear: { year: "numeric" } } });

    expect(t("{value, date, onlyYear}", { value })).toBe("2020");
  });

  it("can modify existing global formats", () => {
    const t = renderDate({ dateTime: { full: { weekday: undefined } } });

    expect(t("{value, date, full}", { value })).toBe("November 19, 2020");
  });

  it("allows to override global formats locally", () => {
    const t = renderDate({ dateTime: { full: { weekday: "long" } } });

    expect(t("{value, date, full}", { value })).toBe("Thursday, November 19, 2020");
  });
});

// Deliberate difference D1, as above: next-intl renders each number as String(n).
describe("performance", () => {
  it("caches message formats for component instances", () => {
    const t = translator();

    // @ts-expect-error -- D1: a number in a plain {count}; next-intl renders "Hello #1"
    expect(() => t("Hello #{count}", { count: 1 })).toThrow(
      'argument "count" got a number: plain {count} takes text; use {count, number} or {count, date}'
    );
  });

  it("reuses message formats across component instances", () => {
    const t = translator();

    // @ts-expect-error -- D1: a number in a plain {value}; next-intl renders "Value 1Value 2Value 3"
    expect(() => [1, 2, 3].map((value) => t("Value {value}", { value })).join("")).toThrow(
      'argument "value" got a number: plain {value} takes text; use {value, number} or {value, date}'
    );
  });
});
