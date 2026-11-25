import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Format } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";
import { IntlProvider, useFormat } from "@elmeragroup/intl/react";
import { getFormat } from "@elmeragroup/intl/server";

import { APP_FORMATS } from "./app-formats";
import { english } from "./catalogs";
import { REQUEST_CONFIG } from "./request-config";

const OSLO = "Europe/Oslo";
// 00:30 on Mar 5 in Oslo, 01:30 in Helsinki, still Mar 4 on the host (America/Los_Angeles).
const instant = new Date("2026-03-04T23:30:00Z");

function formatIn(locale: string, timeZone: string): Format {
  return createIntl({
    locale,
    catalog: english(),
    timeZone,
    formats: APP_FORMATS,
    onError: (error) => {
      throw error;
    },
  }).format;
}

// The calls the adopting app makes, so the server/client check covers each method's path through the config.
function appCalls(format: Format): ReadonlyArray<string> {
  return [
    format.dateTime(instant, "long"),
    format.dateTime(instant, { hour: "numeric", minute: "numeric" }),
    format.number(1234.5678912, "currency"),
    format.list(["a", "b", "c"], { type: "conjunction" }),
    format.relativeTime(new Date("2026-03-04T21:30:00Z"), instant),
  ];
}

// Unit under test: `format` with the adopting app's formats. Oracle: next-intl 4.14.9's createFormatter output for the same
// locale, zone and formats, run once by hand (use-intl/core, TZ=America/Los_Angeles).
describe("format", () => {
  it.each([
    ["en", "March 5, 2026 at 12:30:00 AM", "1,234.567891"],
    ["no", "5. mars 2026 kl. 00:30:00", "1\u00A0234,567891"],
    ["sv", "5 mars 2026 kl. 00:30:00", "1\u00A0234,567891"],
    ["fi", "5. maaliskuuta 2026 klo 0.30.00", "1\u00A0234,567891"],
  ])("renders the adopting app's named formats in %s as next-intl renders them", (locale, long, currency) => {
    const format = formatIn(locale, OSLO);

    expect([format.dateTime(instant, "long"), format.number(1234.5678912, "currency")]).toEqual([
      long,
      currency,
    ]);
  });

  it("formats dates in the configured zone, not the host's", () => {
    expect([
      formatIn("en", OSLO).dateTime(instant, "long"),
      formatIn("en", "Europe/Helsinki").dateTime(instant, "long"),
    ]).toEqual(["March 5, 2026 at 12:30:00 AM", "March 5, 2026 at 1:30:00 AM"]);
  });

  // next-intl's applyTimeZone treats an empty zone as unset.
  it("formats in the configured zone when the options pass an empty one", () => {
    const format = formatIn("en", OSLO);
    const options = { hour: "numeric", timeZone: "" } as const;

    expect([
      format.dateTime(1704812400000, options),
      format.dateTimeRange(1704812400000, 1704816000000, options),
    ]).toEqual(["4 PM", "4\u2009–\u20095 PM"]);
  });

  it("falls back to String(values) for a list with a missing format", () => {
    const { format } = createIntl({
      locale: "en",
      catalog: english(),
      timeZone: OSLO,
      onError: () => undefined,
    });

    expect([format.list("ab", "missing"), format.list(new Set(["apple", "banana"]), "missing")]).toEqual([
      "ab",
      "[object Set]",
    ]);
  });

  // The server translator is rebuilt from the request config field by field, so a field it drops shows here. The
  // request config is test/request-config.ts, which vitest.config.ts aliases as withIntl aliases an app's.
  it("gives the same output from the provider's useFormat and the request's getFormat", async () => {
    let client: ReadonlyArray<string> = [];
    function Probe(): ReactNode {
      client = appCalls(useFormat());

      return null;
    }
    renderToStaticMarkup(
      <IntlProvider {...REQUEST_CONFIG}>
        <Probe />
      </IntlProvider>
    );
    const server = appCalls(await getFormat());

    expect({ client, server }).toEqual({
      client: ["5. mars 2026 kl. 00:30:00", "00:30", "1\u00A0234,567891", "a, b og c", "for 2 timer siden"],
      server: client,
    });
  });
});
