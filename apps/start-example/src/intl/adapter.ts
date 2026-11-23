// How a request picks its locale, catalog, time zone and formats: the one server adapter the root loader, the server
// functions and the API route share.
import { getCookie } from "@tanstack/react-start/server";

import type { Catalog, ServerAdapter } from "@elmeragroup/intl/core";

import { formats } from "./formats";
import type { Locale } from "./locale";
import { chooseLocale, DEFAULT_LOCALE, LOCALE_COOKIE, parseLocale } from "./locale";

// The compiled catalog per locale. The Vite plugin compiles the PO on import; English is the source, so its catalog is
// the PO's msgids (`?source`).
const CATALOGS = {
  en: () => import("./nb.po?source"),
  nb: () => import("./nb.po"),
} satisfies Readonly<Record<Locale, () => Promise<{ readonly default: Catalog }>>>;

/** The app's server adapter. */
export const adapter: ServerAdapter = {
  // A switch stores the cookie, then re-runs the loaders in a new request, which carries it. Start's own cookie reader
  // parses the header, so `start-example-locale=nb=other` reads as `nb=other`, which is no locale.
  resolveLocale: (request) => chooseLocale(getCookie(LOCALE_COOKIE), request.headers.get("accept-language")),
  // One zone for every visitor: dates render the same on the server, in the browser and in the API.
  resolveTimeZone: () => "Europe/Oslo",
  formats,
  loadCatalog: async (locale) => (await CATALOGS[parseLocale(locale) ?? DEFAULT_LOCALE]()).default,
};
