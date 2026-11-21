// Ported from next-intl v4.14.9: the message-output cases of packages/use-intl/src/react/IntlProvider.test.tsx and
// packages/use-intl/src/react/useExtracted.test.tsx (useExtracted keys messages by their source, as ours does). Each
// keeps its next-intl name and hand-written expected output verbatim, and runs through createIntl + t (or <T> for rich
// text). Exclusions and counts: README.md here.
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

// useExtracted.test.tsx's MockProvider: locale en, no zone (the suite's TZ).
const BERLIN = "Europe/Berlin";

describe("IntlProvider.test.tsx", () => {
  // The nested provider supplies the zone, the outer one the formats; ours takes both in one config.
  it("passes on configuration in nested providers", () => {
    const { t } = strictIntl({
      locale: "en",
      timeZone: "Europe/Vienna",
      formats: {
        dateTime: {
          short: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "numeric" },
        },
      },
    });

    expect(t("Now: {now, date, short}", { now: new Date("2021-01-01T00:00:00Z") })).toBe(
      "Now: Jan 1, 2021, 1:00 AM"
    );
  });
});

describe("useExtracted.test.tsx", () => {
  const { t } = strictIntl({ locale: "en", timeZone: BERLIN });

  it("accepts plain messages", () => {
    expect(t("Hello")).toBe("Hello");
  });

  it("accepts ICU arguments", () => {
    expect(t("Hello {name}", { name: "World" })).toBe("Hello World");
  });

  it("accepts rich text messages", () => {
    expect(
      renderStrict(
        <T>
          Hello <b>Jan</b>
        </T>,
        { locale: "en", timeZone: BERLIN }
      )
    ).toBe("Hello <b>Jan</b>");
  });

  // Ported without the object form's `id` and `description`: ours keys by source and keeps no description.
  describe("object form", () => {
    it("allows passing values", () => {
      expect(t("Hello {name}", { name: "World" })).toBe("Hello World");
    });

    // Per-call formats are not part of our API: the instance carries them.
    it("allows passing values and formats", () => {
      const withFormats = strictIntl({
        locale: "en",
        timeZone: BERLIN,
        formats: { number: { precise: { minimumFractionDigits: 5 } } },
      });

      expect(withFormats.t("Hello {name}, {count, number, precise}", { name: "World", count: 1.5 })).toBe(
        "Hello World, 1.50000"
      );
    });

    it("allows passing values with rich text", () => {
      expect(
        renderStrict(
          <T>
            Hello{" "}
            <b>
              <Val name="World" />
            </b>
          </T>,
          { locale: "en", timeZone: BERLIN }
        )
      ).toBe("Hello <b>World</b>");
    });

    it("accepts a description with message", () => {
      expect(t("Right")).toBe("Right");
    });

    it("accepts a description with values", () => {
      expect(t("Hello {name}", { name: "World" })).toBe("Hello World");
    });

    it("accepts a description with rich text", () => {
      expect(
        renderStrict(
          <T>
            Hello <b>Jan</b>
          </T>,
          { locale: "en", timeZone: BERLIN }
        )
      ).toBe("Hello <b>Jan</b>");
    });
  });
});
