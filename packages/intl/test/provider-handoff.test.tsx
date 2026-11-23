import { describe, expect, it } from "vitest";

import type { ServerAdapter } from "@elmeragroup/intl/core";

import { loadIntlConfig } from "../src/start";
import { compiled } from "./catalogs";

const OSLO = "Europe/Oslo";
// The adopting app's `short` date style.
const SHORT_DATE = { dateTime: { short: { year: "numeric", month: "short", day: "numeric" } } } as const;
const catalog = compiled("nb", { "On {d, date, short}": "Den {d, date, short}" }, SHORT_DATE);
const adapter: ServerAdapter = {
  resolveLocale: () => "nb",
  loadCatalog: () => Promise.resolve(catalog),
  resolveTimeZone: () => OSLO,
  formats: SHORT_DATE,
};

// Unit under test: the adapter's catalog and formats reaching Start's loader data, the provider's config. Oracle: the
// adapter's own values, which the loader must hand over unchanged. The server translator's read of the request config
// is format.test.tsx's server/client check; the client half is proved by intl-e2e's formats override.
describe("formats through the adapters", () => {
  it("/start's loadIntlConfig hands the catalog and formats to the provider", async () => {
    expect(await loadIntlConfig(adapter, { headers: new Headers() })).toEqual({
      locale: "nb",
      catalog,
      timeZone: OSLO,
      formats: SHORT_DATE,
    });
  });
});
