import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";

import { loadIntlConfig } from "@elmeragroup/intl/start";

import { SIDEBAR_COOKIE } from "../components/app-config";
import { adapter } from "./adapter";
import { LOCALE_COOKIE, LOCALIZED_CACHE_CONTROL, parseLocale } from "./locale";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/**
 * What the root loader hands the document: the request's locale, compiled catalog, zone and formats for
 * `<IntlProvider>`, and whether the sidebar opens, from the app's own cookie, so the first frame paints it as the
 * visitor left it. Its answer depends on the request's locale, so no shared cache may store it; the root loader runs
 * while the document renders too, so the header it sets is the document's as well, the same as the root route's.
 */
export const getShellConfig = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", LOCALIZED_CACHE_CONTROL);

  return {
    intl: await loadIntlConfig(adapter, getRequest()),
    sidebarOpen: getCookie(SIDEBAR_COOKIE) !== "false",
  };
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
