// The 480 metering points the retailer supplies, ported from Fuse's app-shell block
// (apps/docs/src/app/(docs)/blocks/app-shell/demos/power-data.ts at Fuse 9be80460), and each point's reading history.
//
// A point is its customer, address, area, status, contract and expected use; its readings are not part of it. The
// metering points page draws a point's last 30 days for the rows it shows (`last30Days`), and February's invoices
// (data/power-data.ts) read the points alone, so neither builds 480 histories it does not show.
import type { ContractType, PriceArea } from "./market";
import { pick, round, seeded } from "./seeded-random";

/** Where a metering point is in its customer's lifecycle. */
export const METERING_POINT_STATUSES = ["active", "onboarding", "moving-out", "disconnected"] as const;

/** A metering point's lifecycle status. */
export type MeteringPointStatus = (typeof METERING_POINT_STATUSES)[number];

/** A metering point the retailer supplies. */
export type MeteringPoint = {
  /** The 18-digit GSRN Elhub knows the point by, with its GS1 check digit. */
  readonly id: string;
  readonly customer: string;
  readonly address: string;
  readonly city: string;
  readonly priceArea: PriceArea;
  readonly status: MeteringPointStatus;
  readonly contract: ContractType;
  /** Expected consumption over a year, in kWh. */
  readonly annualKwh: number;
};

const FIRST_NAMES = [
  "Ingrid",
  "Ola",
  "Kari",
  "Lars",
  "Sofie",
  "Henrik",
  "Nora",
  "Magnus",
  "Emma",
  "Jonas",
  "Ida",
  "Sindre",
  "Marte",
  "Eirik",
  "Thea",
  "Anders",
  "Silje",
  "Kristian",
  "Hanna",
  "Petter",
] as const;

const LAST_NAMES = [
  "Hansen",
  "Johansen",
  "Olsen",
  "Larsen",
  "Andersen",
  "Pedersen",
  "Nilsen",
  "Kristiansen",
  "Jensen",
  "Karlsen",
  "Berg",
  "Haugen",
  "Hagen",
  "Bakken",
  "Lunde",
  "Solberg",
  "Moen",
  "Dahl",
] as const;

const STREETS = [
  "Storgata",
  "Kirkegata",
  "Skolegata",
  "Parkveien",
  "Fjordveien",
  "Bjørkeveien",
  "Granveien",
  "Elveveien",
  "Solbakken",
  "Strandgata",
  "Høgdaveien",
  "Lønneveien",
] as const;

const CITIES = {
  NO1: ["Oslo", "Drammen", "Lillestrøm", "Fredrikstad", "Hamar"],
  NO2: ["Kristiansand", "Stavanger", "Arendal", "Sandnes"],
  NO3: ["Trondheim", "Molde", "Ålesund"],
  NO4: ["Tromsø", "Bodø", "Narvik"],
  NO5: ["Bergen", "Voss", "Førde"],
} as const satisfies Readonly<Record<PriceArea, readonly [string, ...Array<string>]>>;

// The attributes cycle with the row's index before the rows are shuffled, so every count and every combination is
// known by hand: price areas repeat every 10 rows, statuses every 12 and contracts every 4. Of 480 points, 48 are in
// NO4, 40 are disconnected and 120 are on a fixed price.
const AREA_CYCLE = ["NO1", "NO5", "NO1", "NO2", "NO3", "NO1", "NO2", "NO1", "NO4", "NO5"] as const;
const STATUS_CYCLE = [
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "onboarding",
  "moving-out",
  "disconnected",
] as const;
const CONTRACT_CYCLE = ["spot", "spot", "fixed", "variable"] as const;

/** How many metering points the portfolio holds. */
export const METERING_POINT_COUNT = 480;

// The GS1 check digit of a GSRN's first 17 digits: weights 3 and 1 from the right, mod 10.
function gs1CheckDigit(digits: string): number {
  const sum = digits.split("").reduce((total, digit, index) => {
    const fromRight = digits.length - 1 - index;

    return total + Number(digit) * (fromRight % 2 === 0 ? 3 : 1);
  }, 0);

  return (10 - (sum % 10)) % 10;
}

function meteringPoints(): ReadonlyArray<MeteringPoint> {
  const random = seeded(7_070_575);
  const points = Array.from({ length: METERING_POINT_COUNT }, (_, index): MeteringPoint => {
    const priceArea = AREA_CYCLE[index % AREA_CYCLE.length] ?? "NO1";
    const annualKwh = Math.round((6000 + random() * 22_000) / 10) * 10;
    const body = `7070575${String(1_000_000_000 + index * 7919 + Math.floor(random() * 7000)).slice(0, 10)}`;

    return {
      id: `${body}${String(gs1CheckDigit(body))}`,
      customer: `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`,
      address: `${pick(random, STREETS)} ${String(1 + Math.floor(random() * 120))}`,
      city: pick(random, CITIES[priceArea]),
      priceArea,
      status: STATUS_CYCLE[index % STATUS_CYCLE.length] ?? "active",
      contract: CONTRACT_CYCLE[index % CONTRACT_CYCLE.length] ?? "spot",
      annualKwh,
    };
  });

  // Fisher–Yates with the same generator: the order looks like a real list, the counts stay.
  for (let index = points.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = points[index];
    const swapped = points[other];

    if (held !== undefined && swapped !== undefined) {
      points[index] = swapped;
      points[other] = held;
    }
  }

  return points;
}

/** Every metering point, in a seeded order. */
export const METERING_POINTS: ReadonlyArray<MeteringPoint> = meteringPoints();

/**
 * A point's consumption per day for the 30 days up to yesterday, in kWh, around its daily mean for late March. A point
 * that is onboarding has no readings before its start, and a disconnected point reads zero. Seeded by the point's
 * GSRN, so each point reads the same history on the server, in the browser and in every test, whichever points are
 * drawn and in whatever order.
 *
 * @param point - The metering point.
 * @returns Thirty days, the oldest first; `null` before supply started.
 */
export function last30Days(point: MeteringPoint): ReadonlyArray<number | null> {
  const random = seeded(Number(point.id.slice(-9)));
  // Late March runs at about 1.2 times a year's average day, falling as spring arrives.
  const mean = (point.annualKwh / 365) * 1.2;
  // An onboarding point started supply on a day in the last two weeks.
  const firstReading = point.status === "onboarding" ? 16 + Math.floor(random() * 12) : 0;

  return Array.from({ length: 30 }, (_, day) => {
    if (day < firstReading) {
      return null;
    }

    return point.status === "disconnected"
      ? 0
      : round(mean * (1.08 - (0.16 * day) / 29) * (0.85 + random() * 0.3), 1);
  });
}
