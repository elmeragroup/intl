// The Norwegian power market the portal trades in: its time zone and calendar, its price areas, the contracts a
// customer can hold and the VAT on electricity. Constants and pure functions only, so the intl adapter, the settings
// form, the invoice Sheet in the browser and the fixture generators each import it without building any of the
// portal's data.

/** The market's time zone, which every chart and date label uses, and the adapter hands the runtime. */
export const TIME_ZONE = "Europe/Oslo";

/** The five Norwegian price areas. */
export const PRICE_AREAS = ["NO1", "NO2", "NO3", "NO4", "NO5"] as const;

/** A Norwegian price area. */
export type PriceArea = (typeof PRICE_AREAS)[number];

/** How a customer pays for energy. */
export const CONTRACT_TYPES = ["spot", "fixed", "variable"] as const;

/** A customer's contract type. */
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** The VAT rate on electricity, which households in NO4 do not pay. */
export const VAT_RATE = 0.25;

// The date of the last Sunday of a month, which is when Europe's clocks change.
function lastSunday(year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));

  return last.getUTCDate() - last.getUTCDay();
}

/**
 * Midnight in Oslo on a calendar date. Summer time (UTC+2) runs from the last Sunday of March to the last Sunday of
 * October; the midnight that starts each of those Sundays is still on the old offset, because the clocks change at
 * night.
 *
 * @param year - The year.
 * @param monthIndex - The month, January as 0.
 * @param day - The day of the month.
 * @returns The instant the day starts in Oslo.
 */
export function osloMidnight(year: number, monthIndex: number, day: number): Date {
  const date = monthIndex * 100 + day;
  const summer = date > 200 + lastSunday(year, 2) && date <= 900 + lastSunday(year, 9);

  return new Date(Date.UTC(year, monthIndex, day, summer ? -2 : -1));
}
