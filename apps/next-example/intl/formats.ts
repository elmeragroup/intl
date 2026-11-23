import type { Formats } from "@elmeragroup/intl/core";

// The app's named styles, in a module of their own: elmera-intl.json names it, so `elmera-intl check` and the PO
// loader dry-format every message with the same definition the adapter hands the runtime. JSON values only.
export const formats = {
  // `{date, date, short}` and `format.dateTime(date, "short")`: "March 5, 2026", over the built-in "3/5/26".
  dateTime: { short: { year: "numeric", month: "long", day: "numeric" } },
  // `{total, number, price}` and `format.number(total, "price")`.
  number: { price: { style: "currency", currency: "NOK" } },
} satisfies Formats;
