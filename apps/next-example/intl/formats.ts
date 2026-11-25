import type { Formats } from "@elmeragroup/intl/core";

// The app's named styles, in a module of their own: elmera-intl.json names it, so `elmera-intl check` and the PO
// loader dry-format every message with the same definition the adapter hands the runtime. JSON values only.
export const formats = {
  // `{date, date, short}` and `format.dateTime(date, "short")`: "March 20, 2026", over the built-in "3/20/26".
  dateTime: {
    short: { year: "numeric", month: "long", day: "numeric" },
    // `{at, time, hourMinute}`: a time of day, "7:00 PM" or "19:00". Its own name, not `short`: a style named like a
    // built-in one merges over it key by key, so `{at, time, short}` would take the calendar fields above and print a
    // date.
    hourMinute: { hour: "numeric", minute: "numeric" },
  },
  number: {
    // `{total, number, price}` and `format.number(total, "price")`: kroner, as the retailer bills in every language, under
    // the locale's narrow symbol ("kr", or "NOK" in Finnish, which has none), as Fuse's currency cells write them.
    price: { style: "currency", currency: "NOK", currencyDisplay: "narrowSymbol" },
    // `{change, number, change}`: a change as a signed percentage, such as "-3.1%" or "+12%".
    change: { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" },
    // `{price, number, spot}`: a spot price in øre, with one fraction digit at most, such as "41.9".
    spot: { maximumFractionDigits: 1 },
  },
} satisfies Formats;
