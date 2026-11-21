import type { Formats } from "@elmeragroup/intl/core";

/**
 * The formats of the first adopting app (a Next.js host app), copied: this package must not depend on an app.
 */
export const APP_FORMATS: Formats = {
  dateTime: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    },
  },
  number: { currency: { maximumFractionDigits: 6 } },
};
