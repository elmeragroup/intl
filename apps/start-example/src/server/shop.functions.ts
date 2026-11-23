// Server functions that answer with translated text: the translator is built from the request, in each handler.
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

import { createIntl } from "@elmeragroup/intl/core";
import { loadIntlConfig } from "@elmeragroup/intl/start";

import { adapter } from "../intl/adapter";
import { LOCALIZED_CACHE_CONTROL } from "../intl/locale";
import { ORDER } from "../intl/messages";

/**
 * What the home route's loader fetches: a notice translated and the delivery window formatted on the server before the
 * route renders. The window is a date range, formatted here rather than in the component: its spacing differs between
 * ICU releases (in English, Node 24's ICU 78.2 uses U+2009 and U+202F where Node 26 and Chromium put plain spaces), so
 * a range formatted on both sides of hydration can differ. Loader data reaches the browser as the server made it.
 */
export const getHomeLoaderData = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", LOCALIZED_CACHE_CONTROL);
  const intl = createIntl(await loadIntlConfig(adapter, getRequest()));

  return {
    notice: intl.t("This notice was translated in a route loader."),
    // In the configured zone, Europe/Oslo, wherever the server runs.
    deliveryWindow: intl.format.dateTimeRange(ORDER.delivery.from, ORDER.delivery.until, {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
});

/** Confirm the example order, in the visitor's language. */
export const confirmOrder = createServerFn({ method: "POST" }).handler(async () => {
  const intl = createIntl(await loadIntlConfig(adapter, getRequest()));

  return intl.t("Thank you! Order {id} is confirmed.", { id: ORDER.id });
});
