"use server";
import { cookies } from "next/headers";

import { getIntl } from "@elmeragroup/intl/server";

import { LOCALE_COOKIE, parseLocale } from "../intl/locale";
import { ORDER } from "../intl/messages";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/**
 * Store the visitor's language. Called by the locale switcher: setting a cookie makes Next re-render the page in this
 * action's response, so the switcher needs no second roundtrip (`refresh: "server-action"`).
 *
 * @param value - The locale the visitor chose, as the network delivered it: parsed here, and ignored unless the app
 *   ships it.
 */
export async function setLocale(value: string): Promise<void> {
  const locale = parseLocale(value);

  if (locale === undefined) {
    return;
  }

  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", sameSite: "lax", maxAge: ONE_YEAR_IN_SECONDS });
}

/**
 * Confirm the example order, in the visitor's language: a server action returns translated text.
 *
 * @returns The confirmation.
 */
export async function confirmOrder(): Promise<string> {
  const intl = await getIntl();

  return intl.t("Thank you! Order {id} is confirmed.", { id: ORDER.id });
}
