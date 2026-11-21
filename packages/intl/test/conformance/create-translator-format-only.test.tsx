// Ported from next-intl v4.14.9, packages/use-intl/src/core/createTranslator.format-only.test.tsx: the same
// translator on messages precompiled by icu-minify. Each case keeps its next-intl name and hand-written expected
// output verbatim, and runs through createIntl + t (or <T> for rich text). Exclusions and counts: README.md here.
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
import { expect, it } from "vitest";

import { T, Val } from "@elmeragroup/intl/react";

import { renderStrict, strictIntl } from "./strict";

const BERLIN = "Europe/Berlin";

it("can handle a plain message", () => {
  expect(strictIntl({ locale: "en", timeZone: BERLIN }).t("Hello")).toBe("Hello");
});

it("can handle an argument", () => {
  expect(strictIntl({ locale: "en", timeZone: BERLIN }).t("Hello {param}", { param: "World" })).toBe(
    "Hello World"
  );
});

// next-intl's message is `<b>Hello {param}</b>`; its expected element is <b>Hello World</b>.
it("can handle rich text", () => {
  expect(
    renderStrict(
      <T>
        <b>
          Hello <Val param="World" />
        </b>
      </T>,
      { locale: "en", timeZone: BERLIN }
    )
  ).toBe("<b>Hello World</b>");
});

// Per-call formats are not part of our API: each case configures the formats next-intl merges for the call (global,
// then the call's) on the instance.
it("merges global and local number formats", () => {
  const { t } = strictIntl({
    locale: "en",
    timeZone: BERLIN,
    formats: {
      number: { compact: { notation: "compact" }, percent: { maximumFractionDigits: 0, style: "percent" } },
    },
  });

  expect(t("{total, number, compact} {rate, number, percent}", { rate: 0.25, total: 1200 })).toBe("1.2K 25%");
});

it("overrides a global number format with a local one", () => {
  const { t } = strictIntl({
    locale: "en",
    timeZone: BERLIN,
    formats: { number: { percent: { maximumFractionDigits: 0, style: "percent" } } },
  });

  expect(t("{rate, number, percent}", { rate: 0.25 })).toBe("25%");
});

it("prefers the local time zone over a global one", () => {
  const { t } = strictIntl({
    locale: "en",
    timeZone: "UTC",
    formats: {
      dateTime: {
        shortDate: { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" },
      },
    },
  });

  expect(t("{value, date, shortDate}", { value: new Date(Date.UTC(2020, 0, 2, 1, 0, 0)) })).toBe(
    "01/01/2020"
  );
});

it("uses the global time zone when no local time zone is set", () => {
  const { t } = strictIntl({
    locale: "en",
    timeZone: "America/Los_Angeles",
    formats: { dateTime: { shortDate: { day: "2-digit", month: "2-digit", year: "numeric" } } },
  });

  expect(t("{value, date, shortDate}", { value: new Date(Date.UTC(2020, 0, 2, 1, 0, 0)) })).toBe(
    "01/01/2020"
  );
});
