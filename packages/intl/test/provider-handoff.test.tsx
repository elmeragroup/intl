import { describe, expect, it } from "vitest";

import type { ServerAdapter } from "@elmeragroup/intl/core";
import { createIntl, resolveIntlConfig } from "@elmeragroup/intl/core";
import { configureRequestIntl, getIntl } from "@elmeragroup/intl/server";

import { loadIntlConfig } from "../src/start";
import { compiled } from "./catalogs";

const OSLO = "Europe/Oslo";
// The adopting app's `short` date style; next-intl renders 00:30 on Mar 5 in Oslo with it as below.
const SHORT_DATE = { dateTime: { short: { year: "numeric", month: "short", day: "numeric" } } } as const;
const catalog = compiled("nb", { "On {d, date, short}": "Den {d, date, short}" }, SHORT_DATE);
const lateUtc = new Date("2026-03-04T23:30:00Z");
const adapter: ServerAdapter = {
  resolveLocale: () => "nb",
  loadCatalog: () => Promise.resolve(catalog),
  resolveTimeZone: () => OSLO,
  formats: SHORT_DATE,
};

// Unit under test: the adapter's formats reaching the server translator and Start's loader data; the client half is
// proved by intl-e2e's formats override. Oracle: next-intl 4.14.9's
// output for the same style, hand-written; built-in `short` would render 3/5/26 and 5.3.26.
describe("formats through the adapters", () => {
  it("the server translator formats with the adapter's formats", async () => {
    // next/server's configureNextIntl composition, with the request's headers given directly (next/headers needs a
    // live Next request scope).
    configureRequestIntl(async () =>
      createIntl(await resolveIntlConfig(adapter, { headers: new Headers() }))
    );
    const { t } = await getIntl();
    expect(t("On {d, date, short}", { d: lateUtc })).toBe("Den 5. mars 2026");
  });

  it("/start's loadIntlConfig hands the catalog and formats to the provider", async () => {
    expect(await loadIntlConfig(adapter, { headers: new Headers() })).toEqual({
      locale: "nb",
      catalog,
      timeZone: OSLO,
      formats: SHORT_DATE,
    });
  });
});
