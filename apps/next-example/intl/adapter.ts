// How a request picks its locale, catalog, time zone and formats: the one server adapter the layout (through
// intl/configure.ts), the server action and the API route share.
import { cookies } from "next/headers";

import type { Catalog, ServerAdapter } from "@elmeragroup/intl/core";

import { formats } from "./formats";
import type { Locale } from "./locale";
import { chooseLocale, DEFAULT_LOCALE, LOCALE_COOKIE, parseLocale } from "./locale";

// The compiled catalog per locale. The Next plugin (withIntl) compiles the PO on import; English is the source, so its
// catalog is the PO's msgids (`?source`).
const CATALOGS = {
  en: () => import("./nb.po?source"),
  nb: () => import("./nb.po"),
} satisfies Readonly<Record<Locale, () => Promise<{ readonly default: Catalog }>>>;

/** The app's server adapter. */
export const adapter: ServerAdapter = {
  // The cookie through `cookies()`, not the request's Cookie header: in a server action that just stored a new choice,
  // only `cookies()` has it, and Next re-renders the page in that action's response. Until configureNextIntl hands the
  // adapter that cookie itself, every Next adapter has to do this (#20).
  resolveLocale: async (request) =>
    chooseLocale((await cookies()).get(LOCALE_COOKIE)?.value, request.headers.get("accept-language")),
  // One zone for every visitor: dates render the same on the server, in the browser and in the API.
  resolveTimeZone: () => "Europe/Oslo",
  formats,
  loadCatalog: async (locale) => (await CATALOGS[parseLocale(locale) ?? DEFAULT_LOCALE]()).default,
};
