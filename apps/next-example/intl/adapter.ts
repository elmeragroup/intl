// How a request picks its locale, catalog, time zone and formats: the one server adapter the request config
// (intl/request.ts, which getIntl reads through withIntl's alias) and the API route share.
import { cookies } from "next/headers";

import type { Catalog, ServerAdapter } from "@elmeragroup/intl/core";

import { TIME_ZONE } from "../data/market";
import { formats } from "./formats";
import type { Locale } from "./locale";
import { chooseLocale, DEFAULT_LOCALE, LOCALE_COOKIE, parseLocale } from "./locale";

// The compiled catalog per locale. The Next plugin (withIntl) compiles the PO on import; English is the source, so its
// catalog is the PO's msgids (`?source`).
const CATALOGS = {
  en: () => import("./nb.po?source"),
  nb: () => import("./nb.po"),
  sv: () => import("./sv.po"),
  fi: () => import("./fi.po"),
} satisfies Readonly<Record<Locale, () => Promise<{ readonly default: Catalog }>>>;

/** The app's server adapter. */
export const adapter: ServerAdapter = {
  // The stored choice through `cookies()`, Next's cookie store, as in any Next code: inside a server action it already
  // holds the choice the action just set, and in the API route it is the request's own cookies.
  resolveLocale: async (request) =>
    chooseLocale((await cookies()).get(LOCALE_COOKIE)?.value, request.headers.get("accept-language")),
  // One zone for every visitor, the market's: dates render the same on the server, in the browser and in the API.
  resolveTimeZone: () => TIME_ZONE,
  formats,
  loadCatalog: async (locale) => (await CATALOGS[parseLocale(locale) ?? DEFAULT_LOCALE]()).default,
};
