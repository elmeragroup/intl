import { expect, it } from "vitest";

import { createIntl } from "@elmeragroup/intl/core";

import { english } from "./catalogs";

// 00:30 on Jan 2 in Oslo (UTC+1), 01:30 in Helsinki (UTC+2), still Jan 1 on the host (America/Los_Angeles).
const lateUtc = new Date("2026-01-01T23:30:00Z");

// Unit under test: one catalog entry, decoded once per catalog, formatted for requests in different zones (one process
// serves brands in several), where a formatter cached without its zone would leak the first request's. Oracle:
// hand-written times. runtime.test.tsx holds the per-argument outputs.
it("formats one compiled message in each request's zone", () => {
  const message = "At {d, time, ::Hm}";
  const catalog = english(message);
  const inZone = (timeZone: string) =>
    createIntl({ locale: "en", catalog, timeZone }).t(message, { d: lateUtc });

  expect([inZone("Europe/Oslo"), inZone("Europe/Helsinki"), inZone("Europe/Oslo")]).toEqual([
    "At 00:30",
    "At 01:30",
    "At 00:30",
  ]);
});
