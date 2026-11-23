import { createServerFn } from "@tanstack/react-start";
import { getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";

import { loadIntlConfig } from "@elmeragroup/intl/start";

import { adapter } from "./adapter";
import { LOCALE_COOKIE, LOCALIZED_CACHE_CONTROL, parseLocale } from "./locale";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** The request's locale, compiled catalog, zone and formats: the root loader hands them to `<IntlProvider>`. */
export const getIntlConfig = createServerFn({ method: "GET" }).handler(() => {
  setResponseHeader("Cache-Control", LOCALIZED_CACHE_CONTROL);

  return loadIntlConfig(adapter, getRequest());
});

/**
 * Store the visitor's language; the locale switcher then re-runs the loaders. The input arrives from the network, so
 * `parseLocale` is its validator, and a locale the app does not ship stores nothing.
 */
export const setLocale = createServerFn({ method: "POST" })
  .validator(parseLocale)
  .handler(({ data: locale }) => {
    if (locale !== undefined) {
      setCookie(LOCALE_COOKIE, locale, { path: "/", sameSite: "lax", maxAge: ONE_YEAR_IN_SECONDS });
    }
  });
