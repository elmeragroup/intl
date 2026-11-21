// Ported from next-intl v4.14.9, packages/use-intl/src/react/useFormatter.test.tsx (the formatting cases). Each case keeps
// its next-intl name and hand-written expected output verbatim, and renders `useFormat()` under <IntlProvider>.
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
import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Format, Formats, IntlConfig } from "@elmeragroup/intl/core";
import { IntlProvider, useFormat } from "@elmeragroup/intl/react";

import { english } from "../catalogs";
import { renderStrict } from "./strict";

// next-intl's MockProvider: en, no messages, Europe/Berlin.
type MockConfig = { readonly timeZone?: string; readonly formats?: Formats };

function config({ timeZone = "Europe/Berlin", formats }: MockConfig): Omit<IntlConfig, "catalog"> {
  return { locale: "en", timeZone, formats };
}

function Probe({ render }: { readonly render: (format: Format) => string }): ReactNode {
  return render(useFormat());
}

// The markup `useFormat()` renders; onError fails the test.
function renderFormat(render: (format: Format) => string, mock: MockConfig = {}): string {
  return renderStrict(<Probe render={render} />, config(mock));
}

// next-intl's error-handling cases: what renders, and the errors onError got.
function renderReporting(render: (format: Format) => string, mock: MockConfig = {}) {
  const errors: Array<Error> = [];
  const html = renderToStaticMarkup(
    <IntlProvider catalog={english()} {...config(mock)} onError={(error) => errors.push(error)}>
      <Probe render={render} />
    </IntlProvider>
  );

  return { html, errors };
}

function tagAndMessage(error: Error | undefined): readonly [string | undefined, string | undefined] {
  return [error && "_tag" in error ? String(error._tag) : undefined, error?.message];
}

describe("dateTime", () => {
  const mockDate = new Date("2020-11-20T10:36:01.516Z");

  it("formats a date", () => {
    expect(renderFormat((format) => format.dateTime(mockDate))).toBe("11/20/2020");
  });

  it("formats a time", () => {
    expect(renderFormat((format) => format.dateTime(mockDate, { minute: "numeric", hour: "numeric" }))).toBe(
      "11:36 AM"
    );
  });

  it("accepts options", () => {
    expect(renderFormat((format) => format.dateTime(mockDate, { month: "long" }))).toBe("November");
  });

  it("formats time", () => {
    expect(renderFormat((format) => format.dateTime(mockDate, { hour: "numeric", minute: "numeric" }))).toBe(
      "11:36 AM"
    );
  });

  it("can use a global date format", () => {
    expect(
      renderFormat((format) => format.dateTime(mockDate, "onlyYear"), {
        formats: { dateTime: { onlyYear: { year: "numeric" } } },
      })
    ).toBe("2020");
  });

  it("can use a global time format", () => {
    expect(
      renderFormat((format) => format.dateTime(mockDate, "onlyHours"), {
        formats: { dateTime: { onlyHours: { hour: "numeric" } } },
      })
    ).toBe("11 AM");
  });

  describe("time zones", () => {
    it("converts a date to the target time zone", () => {
      expect(
        renderFormat((format) =>
          format.dateTime(mockDate, { timeZone: "Asia/Shanghai", hour: "numeric", minute: "numeric" })
        )
      ).toBe("6:36 PM");
    });

    it("can use a global time zone", () => {
      expect(
        renderFormat((format) => format.dateTime(mockDate, { hour: "numeric", minute: "numeric" }), {
          timeZone: "Asia/Shanghai",
        })
      ).toBe("6:36 PM");
    });

    it("can override a global time zone", () => {
      expect(
        renderFormat(
          (format) =>
            format.dateTime(mockDate, { timeZone: "Australia/Sydney", hour: "numeric", minute: "numeric" }),
          { timeZone: "Asia/Shanghai" }
        )
      ).toBe("9:36 PM");
    });
  });

  // next-intl reports an IntlError with a code (MISSING_FORMAT, FORMATTING_ERROR); ours a tagged error. The fallback
  // that renders is next-intl's.
  describe("error handling", () => {
    it("handles missing formats", () => {
      const { html, errors } = renderReporting((format) => format.dateTime(mockDate, "onlyYear"));

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatNotFound",
        "Format `onlyYear` is not available in formats.dateTime.",
      ]);
      expect(html).toMatch(/Nov 20 2020/u);
    });

    it("handles missing formats, which are available as defaults for `useTranslations`", () => {
      const { html, errors } = renderReporting((format) => format.dateTime(mockDate, "medium"));

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatNotFound",
        "Format `medium` is not available in formats.dateTime.",
      ]);
      expect(html).toMatch(/Nov 20 2020/u);
    });

    it("handles formatting errors", () => {
      const { html, errors } = renderReporting(
        // @ts-expect-error -- next-intl's case: an option value Intl rejects.
        (format) => format.dateTime(mockDate, { year: "very long" }),
        { timeZone: "Asia/Shanghai" }
      );

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatFailed",
        "format.dateTime failed: Value very long out of range for Intl.DateTimeFormat options property year",
      ]);
      expect(html).toMatch(/Nov 20 2020/u);
    });
  });
});

describe("number", () => {
  it("formats a number", () => {
    expect(renderFormat((format) => format.number(2948192329.12312))).toBe("2,948,192,329.123");
  });

  it("formats a bigint", () => {
    expect(renderFormat((format) => format.number(123456789123456789n))).toBe("123,456,789,123,456,789");
  });

  it("accepts options", () => {
    expect(renderFormat((format) => format.number(299.99, { currency: "EUR", style: "currency" }))).toBe(
      "€299.99"
    );
  });

  it("can use a global format", () => {
    expect(
      renderFormat((format) => format.number(10000, "noGrouping"), {
        formats: { number: { noGrouping: { useGrouping: false } } },
      })
    ).toBe("10000");
  });

  describe("error handling", () => {
    const mockNumber = 10000;

    it("handles missing formats", () => {
      const { html, errors } = renderReporting((format) => format.number(mockNumber, "missing"));

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatNotFound",
        "Format `missing` is not available in formats.number.",
      ]);
      expect(html).toBe("10000");
    });

    it("handles formatting errors", () => {
      const { html, errors } = renderReporting((format) =>
        format.number(mockNumber, { currency: "unknown" })
      );

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatFailed",
        "format.number failed: Invalid currency code : unknown",
      ]);
      expect(html).toBe("10000");
    });
  });
});

describe("relativeTime", () => {
  it.each([
    ["can format now", "2020-11-20T10:36:00.000Z", "2020-11-20T10:36:00.100Z", "now"],
    ["can format seconds", "2020-11-20T10:35:31.000Z", "2020-11-20T10:36:00.000Z", "29 seconds ago"],
    ["can format minutes", "2020-11-20T10:12:00.000Z", "2020-11-20T10:36:00.000Z", "24 minutes ago"],
    [
      "uses the lowest unit possible",
      "2020-11-20T09:37:00.000Z",
      "2020-11-20T10:36:00.000Z",
      "59 minutes ago",
    ],
    ["can format hours", "2020-11-20T08:30:00.000Z", "2020-11-20T10:36:00.000Z", "2 hours ago"],
    ["can format days", "2020-11-17T10:36:00.000Z", "2020-11-20T10:36:00.000Z", "3 days ago"],
    ["can format weeks", "2020-11-02T10:36:00.000Z", "2020-11-20T10:36:00.000Z", "3 weeks ago"],
    ["can format months", "2020-03-02T10:36:00.000Z", "2020-11-20T10:36:00.000Z", "9 months ago"],
    ["can format years", "1984-11-20T10:36:00.000Z", "2020-11-20T10:36:00.000Z", "36 years ago"],
  ])("%s", (_name, date, now, expected) => {
    expect(renderFormat((format) => format.relativeTime(new Date(date), new Date(now)))).toBe(expected);
  });

  describe("error handling", () => {
    it("handles formatting errors", () => {
      const { html, errors } = renderReporting(
        // @ts-expect-error -- next-intl's case: an untyped caller passing text where a timestamp belongs.
        (format) => format.relativeTime("not a number", -20)
      );

      expect(tagAndMessage(errors[0])).toEqual([
        "FormatFailed",
        "format.relativeTime failed: Value need to be finite number for Intl.RelativeTimeFormat.prototype.format()",
      ]);
      expect(html).toBe("not a number");
    });
  });
});

describe("list", () => {
  it("formats a list", () => {
    let result: unknown;
    const html = renderFormat((format) => {
      const value = format.list(["apple", "banana", "orange"]);
      result = value;

      return value;
    });

    expect(result).toBeTypeOf("string");
    expect(html).toBe("apple, banana, and orange");
  });

  it("accepts a set", () => {
    expect(renderFormat((format) => format.list(new Set(["apple", "banana", "orange"])))).toBe(
      "apple, banana, and orange"
    );
  });

  it("accepts options", () => {
    expect(
      renderFormat((format) => format.list(["apple", "banana", "orange"], { type: "disjunction" }))
    ).toBe("apple, banana, or orange");
  });

  it("can use a global format", () => {
    expect(
      renderFormat((format) => format.list(["apple", "banana", "orange"], "enumeration"), {
        formats: { list: { enumeration: { style: "short" } } },
      })
    ).toBe("apple, banana, &amp; orange");
  });
});
