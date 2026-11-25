"use server";
import { cookies } from "next/headers";

import { getT } from "@elmeragroup/intl/server";

export async function runAction(): Promise<string> {
  const t = await getT();

  return t("Action result");
}

/** What the action read before and after it set the locale cookie. */
export type ActionSwitchTexts = { readonly before: string; readonly after: string };

// The locale switch as a server action: the translation it reads after `cookies().set` is in the new locale, because
// createRequestConfig hands the adapter the cookie the action set, and so is the page Next re-renders in this
// action's own response.
export async function switchLocaleInAction(locale: string): Promise<ActionSwitchTexts> {
  const beforeT = await getT();
  const before = beforeT("Read in the action");
  const jar = await cookies();
  jar.set("locale", locale === "en" ? "en" : "no", { path: "/" });
  const afterT = await getT();
  const after = afterT("Read in the action");

  return { before, after };
}
