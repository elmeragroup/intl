import type { Formats } from "@elmeragroup/intl/core";

// The API's named styles, in a module of their own: elmera-intl.json names it, so `elmera-intl check` and the catalog
// loader dry-format every message with the same definition the middleware hands the runtime. JSON values only.
export const formats = {
  // `{dueOn, date, short}`: "March 20, 2026", over the built-in "3/20/26".
  dateTime: {
    short: { year: "numeric", month: "long", day: "numeric" },
  },
  number: {
    // `format.number(amount, "price")`: kroner, as the retailer bills in every language, under the locale's narrow
    // symbol ("kr", or "NOK" in Finnish, which has none), as the host examples write them.
    price: { style: "currency", currency: "NOK", currencyDisplay: "narrowSymbol" },
  },
} satisfies Formats;
