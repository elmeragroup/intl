// The portal's data: the back office of a Nordic power retailer with 480 metering points, ported from Fuse's app-shell
// block (apps/docs/src/app/(docs)/blocks/app-shell/demos/power-data.ts at Fuse 9be80460): the market's consumption and
// prices, February's invoices and the latest activity. The points are in data/metering-points.ts, the invoice run's
// counts in data/invoice-run.ts and the market's zone and areas in data/market.ts, each a module of its own, so a page
// that needs one does not build the rest.
//
// Every value comes from a seeded generator or a hand-written table, so each load, each render and each test sees the
// same rows. Replace these modules with your API: the pages read nothing else. The data holds no English sentence: a
// label is a msg() descriptor that the page translates with `t.from`, and a sentence is data the page renders through
// one message, so a translator orders its parts. The labels' descriptors are in intl/messages.ts. Every instant is in
// Europe/Oslo, so the dashboard's "today" is 29 March 2026, the day summer time starts.
import { INVOICE_COUNT, INVOICE_STATE_COUNTS, invoiceStateAt } from "./invoice-run";
import { osloMidnight, VAT_RATE } from "./market";
import type { ContractType, PriceArea } from "./market";
import { METERING_POINTS } from "./metering-points";
import { round, seeded } from "./seeded-random";

/**
 * The moment the dashboard shows: 13:20 on Sunday 29 March 2026 in Oslo, in summer time. Relative times are measured
 * from it, so the server and the browser render the same phrase; an app passes its clock's `now`.
 */
export const AS_OF = new Date("2026-03-29T13:20:00+02:00");

/** One day of the month's consumption, this year against the same day last year. */
export type DailyConsumption = {
  /** Midnight in Oslo, the start of the day. */
  readonly day: Date;
  /** Consumption in MWh, or `null` for today and the days still to come. */
  readonly thisYear: number | null;
  /** Consumption on the same date last year, in MWh. */
  readonly lastYear: number;
};

/** One quarter-hour of the day-ahead spot price. */
export type SpotQuarter = {
  /** The quarter's first instant. */
  readonly start: Date;
  /** The NO1 price in øre per kWh, VAT excluded. */
  readonly price: number;
};

/** One month of the portfolio's consumption and its prosumers' solar production. */
export type MonthlyEnergy = {
  /** Midnight in Oslo on the month's first day. */
  readonly month: Date;
  /** Consumption in MWh. */
  readonly consumption: number;
  /** Solar production fed into the grid, in MWh. */
  readonly production: number;
};

/** Where an invoice is in its life. Each state carries what only it knows. */
export type InvoiceState =
  | { readonly _tag: "Paid"; readonly paidOn: Date }
  | { readonly _tag: "Open" }
  | { readonly _tag: "Overdue" }
  | { readonly _tag: "Credited"; readonly creditNote: string };

/** One line of an invoice, in kr with VAT excluded: the energy at its price, or the monthly fee. */
export type InvoiceLine =
  | {
      readonly _tag: "Energy";
      readonly contract: ContractType;
      readonly kwh: number;
      /** The price per kWh, in øre with VAT excluded. */
      readonly priceOre: number;
      readonly amount: number;
    }
  | { readonly _tag: "MonthlyFee"; readonly amount: number };

/** One customer's invoice for February 2026. */
export type Invoice = {
  readonly number: string;
  readonly customer: string;
  readonly meteringPointId: string;
  readonly priceArea: PriceArea;
  readonly contract: ContractType;
  readonly issuedOn: Date;
  readonly dueOn: Date;
  readonly energyKwh: number;
  readonly lines: readonly [InvoiceLine, ...Array<InvoiceLine>];
  /** The VAT in kr; zero in NO4, where households in Northern Norway pay no VAT on electricity. */
  readonly vat: number;
  /** What the customer pays, in kr. */
  readonly total: number;
  readonly state: InvoiceState;
};

/** One entry in the overview's activity list: what happened, with the figures its sentence names. */
export type Activity =
  | {
      readonly _tag: "PriceAlert";
      readonly id: string;
      readonly at: Date;
      readonly ore: number;
      readonly customers: number;
    }
  | { readonly _tag: "Readings"; readonly id: string; readonly at: Date; readonly day: Date }
  | {
      readonly _tag: "MoveIn";
      readonly id: string;
      readonly at: Date;
      readonly customers: number;
      readonly later: number;
      readonly startsOn: Date;
    }
  | {
      readonly _tag: "Payments";
      readonly id: string;
      readonly at: Date;
      readonly paid: number;
      readonly overdue: number;
    }
  | {
      readonly _tag: "InvoiceRun";
      readonly id: string;
      readonly at: Date;
      readonly invoices: number;
      readonly dueOn: Date;
      readonly directDebitDueOn: Date;
    };

const QUARTER_MS = 15 * 60 * 1000;

// NO1's day-ahead price per elapsed hour of 29 March 2026, in øre per kWh with VAT excluded. Elapsed hour 2 is 03:00,
// because 02:00 does not exist that day. Typed by hand, not market data.
const HOURLY_PRICE = [
  61.8, 58.2, 55.1, 54.6, 56.9, 61.3, 68.4, 77.9, 81.2, 72.5, 58.7, 44.3, 36.8, 35.2, 41.9, 57.4, 79.6, 104.8,
  118.3, 109.1, 91.7, 78.4, 69,
] as const;

function spotToday(): ReadonlyArray<SpotQuarter> {
  const random = seeded(29_03_2026);
  const start = osloMidnight(2026, 2, 29).getTime();

  return HOURLY_PRICE.flatMap((price, hour) => {
    const next = HOURLY_PRICE[hour + 1] ?? price;

    return [0, 1, 2, 3].map((quarter) => ({
      start: new Date(start + (hour * 4 + quarter) * QUARTER_MS),
      price: round(price + ((next - price) * quarter) / 8 + (random() - 0.5) * 2.4, 2),
    }));
  });
}

/** Today's 92 quarter-hours of NO1 spot price, each eased toward the next hour. */
export const SPOT_TODAY: ReadonlyArray<SpotQuarter> = spotToday();

/** NO1's average spot price over the last 30 days, in øre per kWh with VAT excluded. */
export const SPOT_30_DAY_AVERAGE = 72.4;

/** How a price compares with the 30-day average, as a price-level badge says it. */
export type PriceLevel = "low" | "normal" | "high";

/**
 * The level of a spot price: low under 80 % of the 30-day average, high over 125 %.
 *
 * @param price - A spot price in øre per kWh.
 * @returns The price's level.
 */
export function priceLevel(price: number): PriceLevel {
  if (price < SPOT_30_DAY_AVERAGE * 0.8) {
    return "low";
  }

  return price > SPOT_30_DAY_AVERAGE * 1.25 ? "high" : "normal";
}

/**
 * The quarter-hour that holds `at`: the one that starts at or before it and ends after it.
 *
 * @param at - Any instant.
 * @returns The quarter, or `undefined` outside today's 92 quarters.
 */
export function spotAt(at: Date): SpotQuarter | undefined {
  const time = at.getTime();

  return SPOT_TODAY.find(
    (quarter) => quarter.start.getTime() <= time && time < quarter.start.getTime() + QUARTER_MS
  );
}

const PORTFOLIO_ANNUAL_MWH = 7680;
const SOLAR_ANNUAL_MWH = 312;

// Each month's share of a year's consumption and of a year's solar production, in percent, January first. Both columns
// add up to 100: heating drives the winter peak, daylight the summer one.
const CONSUMPTION_SHARE = [12.6, 11.2, 10.4, 8, 6.2, 4.9, 4.6, 5, 6, 8, 10.2, 12.9] as const;
const SOLAR_SHARE = [1, 3, 7, 11, 15, 16, 15, 13, 10, 6, 2, 1] as const;

/** The twelve complete months up to the current one, March 2025 to February 2026. */
export const MONTHLY_ENERGY: ReadonlyArray<MonthlyEnergy> = Array.from({ length: 12 }, (_, offset) => {
  const monthIndex = (2 + offset) % 12;
  const year = offset < 10 ? 2025 : 2026;

  return {
    month: osloMidnight(year, monthIndex, 1),
    consumption: round((PORTFOLIO_ANNUAL_MWH * (CONSUMPTION_SHARE[monthIndex] ?? 0)) / 100, 1),
    production: round((SOLAR_ANNUAL_MWH * (SOLAR_SHARE[monthIndex] ?? 0)) / 100, 1),
  };
});

const MARCH_SHARE = CONSUMPTION_SHARE[2] / 100;

/** Days of March whose readings are in: the 1st to the 28th. Today's are still arriving. */
export const COMPLETE_DAYS = 28;

// A March day's consumption in MWh: the month's mean, colder early in the month, a little more at weekends, and a few
// percent of weather on top.
function marchDay(day: number, weekday: number, random: () => number, scale: number): number {
  const trend = 1.12 - (0.2 * (day - 1)) / 30;
  const weekend = weekday === 0 || weekday === 6 ? 1.05 : 1;
  const weather = 0.96 + random() * 0.08;

  return round(((PORTFOLIO_ANNUAL_MWH * MARCH_SHARE) / 31) * trend * weekend * weather * scale, 1);
}

function dailyConsumption(): ReadonlyArray<DailyConsumption> {
  const thisYear = seeded(2026);
  const lastYear = seeded(2025);

  return Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    const now = marchDay(day, new Date(Date.UTC(2026, 2, day)).getUTCDay(), thisYear, 1);

    return {
      day: osloMidnight(2026, 2, day),
      thisYear: day <= COMPLETE_DAYS ? now : null,
      lastYear: marchDay(day, new Date(Date.UTC(2025, 2, day)).getUTCDay(), lastYear, 1.04),
    };
  });
}

/** March 2026 day by day, against March 2025, which was a little colder. */
export const DAILY_CONSUMPTION: ReadonlyArray<DailyConsumption> = dailyConsumption();

function dailySolar(): ReadonlyArray<{ readonly thisYear: number; readonly lastYear: number }> {
  const thisYear = seeded(326);
  const lastYear = seeded(325);
  const mean = (SOLAR_ANNUAL_MWH * (SOLAR_SHARE[2] / 100)) / 31;
  // Days lengthen through March, and clouds take a share of each day.
  const day = (index: number, random: () => number) =>
    round(mean * (0.6 + (0.8 * index) / 30) * (0.45 + random() * 0.85), 2);

  return Array.from({ length: COMPLETE_DAYS }, (_, index) => ({
    thisYear: day(index, thisYear),
    lastYear: day(index, lastYear),
  }));
}

/** The prosumers' solar production for each complete day of March 2026 and of March 2025, in MWh. */
export const DAILY_SOLAR: ReadonlyArray<{ readonly thisYear: number; readonly lastYear: number }> =
  dailySolar();

// February's average spot price per area, in øre per kWh with VAT excluded. Typed by hand.
const FEBRUARY_SPOT = {
  NO1: 88.2,
  NO2: 84.6,
  NO3: 41.3,
  NO4: 18.9,
  NO5: 79.8,
} as const satisfies Readonly<Record<PriceArea, number>>;

const SPOT_MARKUP_ORE = 4.9;
const CONTRACT_PRICE_ORE = { fixed: 99, variable: 89.9 } as const;
const MONTHLY_FEE_KR = 49;

// NO1's average day-ahead price on each complete day of March 2026, in øre per kWh with VAT excluded: cheaper at
// weekends and as the month warms. Typed by hand, not market data.
const MARCH_SPOT = [
  96.4, 102.8, 108.1, 99.5, 93.2, 81.7, 74.9, 90.3, 97.8, 104.6, 95.1, 88.4, 72.6, 66.3, 84.9, 91.2, 86.7,
  79.4, 82.8, 69.5, 58.2, 63.7, 77.1, 80.6, 74.3, 68.9, 55.4, 51.8,
] as const;

/**
 * What each complete day of March will invoice, in kr: the day's consumption at the day's spot price plus the markup,
 * with VAT. An estimate, because NO4 pays no VAT and fixed contracts pay their own price, which the bills will settle.
 */
export const DAILY_INVOICING: ReadonlyArray<number> = DAILY_CONSUMPTION.slice(0, COMPLETE_DAYS).map(
  (day, index) =>
    round(
      (((day.thisYear ?? 0) * 1000 * ((MARCH_SPOT[index] ?? 0) + SPOT_MARKUP_ORE)) / 100) * (1 + VAT_RATE),
      2
    )
);

function februaryPriceOre(contract: ContractType, priceArea: PriceArea): number {
  return contract === "spot" ? FEBRUARY_SPOT[priceArea] + SPOT_MARKUP_ORE : CONTRACT_PRICE_ORE[contract];
}

/** The day February's invoices went out: 09:00 on 6 March 2026 in Oslo. */
export const INVOICES_ISSUED_ON = new Date("2026-03-06T09:00:00+01:00");

/** The period February's invoices bill: the whole month, from its first midnight in Oslo to its last instant. */
export const BILLING_PERIOD = {
  from: osloMidnight(2026, 1, 1),
  until: new Date(osloMidnight(2026, 2, 1).getTime() - 1),
} as const;

function invoices(): ReadonlyArray<Invoice> {
  const random = seeded(202_602);

  return METERING_POINTS.filter((point) => point.status !== "onboarding")
    .slice(0, INVOICE_COUNT)
    .map((point, index): Invoice => {
      const energyKwh = Math.round(point.annualKwh * (CONSUMPTION_SHARE[1] / 100));
      const priceOre = round(februaryPriceOre(point.contract, point.priceArea), 2);
      const energy = round((energyKwh * priceOre) / 100, 2);
      const subtotal = round(energy + MONTHLY_FEE_KR, 2);
      const vat = point.priceArea === "NO4" ? 0 : round(subtotal * VAT_RATE, 2);
      const tag = invoiceStateAt(index);
      const number = `INV-2602-${String(index + 1).padStart(4, "0")}`;
      const state: InvoiceState =
        tag === "Paid"
          ? { _tag: "Paid", paidOn: osloMidnight(2026, 2, 10 + Math.floor(random() * 10)) }
          : tag === "Credited"
            ? { _tag: "Credited", creditNote: `CN-2603-${String(index + 1).padStart(4, "0")}` }
            : { _tag: tag };

      return {
        number,
        customer: point.customer,
        meteringPointId: point.id,
        priceArea: point.priceArea,
        contract: point.contract,
        issuedOn: INVOICES_ISSUED_ON,
        // Open invoices are direct-debit customers', due a month after the others.
        dueOn: tag === "Open" ? osloMidnight(2026, 3, 7) : osloMidnight(2026, 2, 20),
        energyKwh,
        lines: [
          { _tag: "Energy", contract: point.contract, kwh: energyKwh, priceOre, amount: energy },
          { _tag: "MonthlyFee", amount: MONTHLY_FEE_KR },
        ],
        vat,
        total: round(subtotal + vat, 2),
        state,
      };
    });
}

/** February's invoices, for the first 72 points that were supplied all month. */
export const INVOICES: ReadonlyArray<Invoice> = invoices();

/** The overview's latest activity, newest first. */
export const ACTIVITY: ReadonlyArray<Activity> = [
  {
    _tag: "PriceAlert",
    id: "price-alert-no1",
    at: new Date("2026-03-29T12:45:00+02:00"),
    ore: 115,
    customers: 312,
  },
  {
    _tag: "Readings",
    id: "readings-0328",
    at: new Date("2026-03-29T07:10:00+02:00"),
    day: osloMidnight(2026, 2, 28),
  },
  {
    _tag: "MoveIn",
    id: "move-in-0328",
    at: new Date("2026-03-28T16:30:00+01:00"),
    customers: 12,
    later: 9,
    startsOn: osloMidnight(2026, 3, 1),
  },
  {
    _tag: "Payments",
    id: "payments-0327",
    at: new Date("2026-03-27T09:05:00+01:00"),
    paid: INVOICE_STATE_COUNTS.Paid,
    overdue: INVOICE_STATE_COUNTS.Overdue,
  },
  {
    _tag: "InvoiceRun",
    id: "invoice-run-0306",
    at: INVOICES_ISSUED_ON,
    invoices: INVOICE_COUNT,
    dueOn: osloMidnight(2026, 2, 20),
    directDebitDueOn: osloMidnight(2026, 3, 7),
  },
];
