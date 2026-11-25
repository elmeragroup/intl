// The overview's chart rows, each x already a label in the request's language, formatted on the server.
//
// Fuse's charts write their x labels where they render: the table, the spoken summary, each point's name. The charts
// are client components, so they render twice, on the server and again in the browser as the page hydrates, and Node's
// ICU and the browser's can write one date two ways (English "Mar 29, 2026, 1:20 PM" in Node, "Mar 29, 2026 at 1:20
// PM" in WebKit). A
// mismatch makes React throw the server's HTML away and render the page again. So the overview's loader formats each
// chart's x on the server, as a category, and the route hands the charts that loader data: the browser hydrates the
// very string the server rendered, and server and client agree by construction. The cost is the time axis's own
// features, its "now" and its pending days; the spot chart marks the current quarter by its label instead.
import type { Format } from "@elmeragroup/intl/core";

import {
  AS_OF,
  DAILY_CONSUMPTION,
  MONTHLY_ENERGY,
  SPOT_30_DAY_AVERAGE,
  SPOT_TODAY,
  spotAt,
} from "../data/power-data";

/** One day of the daily chart: the day as a label, this year's consumption and last year's, in MWh. */
export type DailyRow = { readonly day: string; readonly thisYear: number | null; readonly lastYear: number };

/** One quarter-hour of the spot chart: its start as a label, the price and the 30-day average, in øre per kWh. */
export type SpotRow = { readonly start: string; readonly price: number; readonly average: number };

/** One month of the energy chart: the month as a label, consumption and solar production, in MWh. */
export type MonthlyRow = {
  readonly month: string;
  readonly consumption: number;
  readonly production: number;
};

/** The overview's three charts, their rows labelled on the server. */
export type OverviewCharts = {
  readonly daily: ReadonlyArray<DailyRow>;
  readonly spot: ReadonlyArray<SpotRow>;
  /** The label of the quarter-hour that holds the dashboard's moment, which the spot chart marks. */
  readonly spotNow: string;
  readonly monthly: ReadonlyArray<MonthlyRow>;
};

// "March 1": a day of the month, as the daily chart's axis, table and points name it.
const DAY = { month: "long", day: "numeric" } as const;

// "Mar 2025": a month and its year, short enough for the energy chart's axis.
const MONTH = { month: "short", year: "numeric" } as const;

/**
 * The overview's chart rows, every x formatted in the request's locale and zone.
 *
 * @param format - The request's formatter, built on the server in the overview's loader.
 * @returns The rows of each chart, and the current quarter's label.
 */
export function overviewCharts(format: Format): OverviewCharts {
  // A quarter-hour by its start, "1:15 PM" or "13:15". 29 March has no 02:00, so every label is still unique.
  const quarter = (start: Date) => format.dateTime(start, "hourMinute");
  const now = spotAt(AS_OF);

  return {
    daily: DAILY_CONSUMPTION.map((day) => ({
      day: format.dateTime(day.day, DAY),
      thisYear: day.thisYear,
      lastYear: day.lastYear,
    })),
    // The 30-day average rides along each quarter as a flat series, so the legend names it and the tooltip reads it
    // beside the price, with no label over the line.
    spot: SPOT_TODAY.map((row) => ({
      start: quarter(row.start),
      price: row.price,
      average: SPOT_30_DAY_AVERAGE,
    })),
    spotNow: now === undefined ? "" : quarter(now.start),
    monthly: MONTHLY_ENERGY.map((month) => ({
      month: format.dateTime(month.month, MONTH),
      consumption: month.consumption,
      production: month.production,
    })),
  };
}
