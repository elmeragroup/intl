import type { Formats } from "@elmeragroup/intl/core";

// The app's formats, in a module of their own so elmera-intl's compiler loads the same definition (elmera-intl.json).
// Overrides the built-in short date (3/5/26), as an adopting app's formats may.
export const formats = {
  dateTime: { short: { year: "numeric", month: "short", day: "numeric" } },
} satisfies Formats;
