// Ported from next-intl v4.14.9, packages/use-intl/src/core/createTranslator.test.tsx. Each case keeps its
// next-intl name and hand-written expected output verbatim, and runs through createIntl + t (or <T> for rich text).
// Exclusions and counts: README.md in this directory.
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
import { describe, expect, it } from "vitest";

import { T, Val } from "@elmeragroup/intl/react";

import { renderStrict, strictIntl } from "./strict";

// next-intl's suite runs with TZ=Europe/Berlin and no configured zone; ours always configures one.
const BERLIN = "Europe/Berlin";

it("supports alphanumeric value names", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  expect(t("{val_u3}", { val_u3: "Hello" })).toBe("Hello");
});

it("can handle nested blocks in selects", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  expect(
    t("{foo, select, one {One: {one}} two {Two: {two}} other {Other: {other}}}", {
      foo: "one",
      one: "One",
      two: "Two",
      other: "Other",
    })
  ).toBe("One: One");
});

it("can handle nested blocks in plurals", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  expect(
    t("{count, plural, one {One: {one}} other {Other: {other}}}", { count: 1, one: "One", other: "Other" })
  ).toBe("One: One");
});

// Ours has no production fast path: every message compiles, so the escape is always honoured.
it("strips ICU escape quotes from `<` in production builds", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  expect(t("styleguide.'<locale>'.md")).toBe("styleguide.<locale>.md");
});

// Per-call formats (`t(key, values, formats)`) are not part of our API: each case configures the formats next-intl
// merges for the call (global, then the call's) on the instance.
describe("numbers in messages", () => {
  it("can pass an inline format", () => {
    const { t } = strictIntl({
      locale: "en",
      timeZone: BERLIN,
      formats: { number: { precise: { minimumFractionDigits: 5 } } },
    });

    expect(t("{count, number, precise}", { count: 1.5 })).toBe("1.50000");
  });

  it("can merge an inline format with global formats", () => {
    const { t } = strictIntl({
      locale: "en",
      timeZone: BERLIN,
      formats: { number: { precise: { minimumFractionDigits: 5 }, integer: { minimumFractionDigits: 0 } } },
    });

    expect(t("{count, number, precise} {count, number, integer}", { count: 1.5 })).toBe("1.50000 2");
  });
});

describe("big integers in messages", () => {
  it("can pass an inline format", () => {
    const { t } = strictIntl({
      locale: "en",
      timeZone: BERLIN,
      formats: { number: { coarse: { maximumSignificantDigits: 3 } } },
    });

    expect(t("{count, number, coarse}", { count: 123456789123456789123456n })).toBe(
      "123,000,000,000,000,000,000,000"
    );
  });

  it("can merge an inline format with global formats", () => {
    const { t } = strictIntl({
      locale: "en",
      timeZone: BERLIN,
      formats: {
        number: { coarse: { maximumSignificantDigits: 3 }, precise: { maximumSignificantDigits: 21 } },
      },
    });

    expect(t("{count, number, coarse} {count, number, precise}", { count: 123456789123456789123456n })).toBe(
      "123,000,000,000,000,000,000,000 123,456,789,123,456,789,123,000"
    );
  });
});

describe("dates in messages", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  // next-intl names each case by its skeleton; the message is `{date, date, ::<skeleton>}`.
  it.each([
    ["{date, date, ::G}", "7/9/2024 AD"],
    ["{date, date, ::GG}", "7/9/2024 AD"],
    ["{date, date, ::GGGG}", "7/9/2024 Anno Domini"],
    ["{date, date, ::GGGGG}", "7/9/2024 A"],

    ["{date, date, ::y}", "2024"],
    ["{date, date, ::yy}", "24"],
    ["{date, date, ::yyyy}", "2024"],

    ["{date, date, ::M}", "7"],
    ["{date, date, ::MM}", "07"],
    ["{date, date, ::MMM}", "Jul"],
    ["{date, date, ::MMMM}", "July"],
    ["{date, date, ::MMMMM}", "J"],

    ["{date, date, ::L}", "7"],
    ["{date, date, ::LL}", "07"],
    ["{date, date, ::LLL}", "Jul"],
    ["{date, date, ::LLLL}", "July"],
    ["{date, date, ::LLLLL}", "J"],

    ["{date, date, ::d}", "9"],
    ["{date, date, ::dd}", "09"],

    ["{date, date, ::E}", "Tue"],
    ["{date, date, ::EE}", "Tue"],
    ["{date, date, ::EEE}", "Tue"],
    ["{date, date, ::EEEE}", "Tuesday"],
    ["{date, date, ::EEEEE}", "T"],

    ["{date, date, ::h}", "12 AM", "2024-07-09T22:00:00.000Z"],
    ["{date, date, ::h}", "9 AM"],
    ["{date, date, ::hh}", "09 AM"],

    ["{date, date, ::HH}", "09"],
    ["{date, date, ::HH}", "00", "2024-07-09T22:00:00.000Z"],

    ["{date, date, ::K}", "0 AM", "2024-07-09T22:00:00.000Z"],
    ["{date, date, ::KK}", "00 AM", "2024-07-09T22:00:00.000Z"],
    ["{date, date, ::K}", "9 AM"],
    ["{date, date, ::KK}", "09 AM"],

    ["{date, date, ::kk}", "09"],
    ["{date, date, ::kk}", "24", "2024-07-09T22:00:00.000Z"],

    ["{date, date, ::m}", "6"],

    ["{date, date, ::s}", "3"],
    ["{date, date, ::mmss}", "06:03"],

    ["{date, date, ::z}", "7/9/2024, GMT+2"],
    ["{date, date, ::zz}", "7/9/2024, GMT+2"],
    ["{date, date, ::zzz}", "7/9/2024, GMT+2"],
    ["{date, date, ::zzzz}", "7/9/2024, Central European Summer Time"],

    ["{date, date, ::yyyyMMMd}", "Jul 9, 2024"],
    [
      "{date, date, ::GGGGyyyyMMMMEdhmszzzz}",
      "Tue, July 9, 2024 Anno Domini at 9:06:03 AM Central European Summer Time",
    ],
  ] as const)("%s: %s", (message, expected, dateString?: string) => {
    expect(t(message, { date: new Date(dateString ?? "2024-07-09T07:06:03.320Z") })).toBe(expected);
  });

  it("can set a time zone in a built-in default format", () => {
    const kolkata = strictIntl({ locale: "en", timeZone: "Asia/Kolkata" });

    expect(kolkata.t("{date, time, full}", { date: new Date("2023-12-31T18:30:00.000Z") })).toBe(
      "12:00:00 AM GMT+5:30"
    );
  });
});

// next-intl's message is `<b>Hello <i>{name}</i>!</b>` with tag renderers; <T> writes the same message as JSX.
describe("t.rich", () => {
  it("can translate a message to a ReactNode", () => {
    expect(
      renderStrict(
        <T>
          <b>
            Hello{" "}
            <i>
              <Val name="world" />
            </i>
            !
          </b>
        </T>,
        { locale: "en", timeZone: BERLIN }
      )
    ).toBe("<b>Hello <i>world</i>!</b>");
  });
});
