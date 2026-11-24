"use server";
import { cookies } from "next/headers";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getIntl } from "@elmeragroup/intl/server";

import { parseSettings } from "../data/settings";
import type { SaveOutcome, SettingsDraft } from "../data/settings";
import { LOCALE_COOKIE, parseLocale } from "../intl/locale";
import { CONTRACT_LABELS } from "../intl/messages";

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

// The draft as the network delivers it: any JSON, whatever the caller's types said, since anyone can post to an action.
// Its shape is decoded here, then `parseSettings` parses its fields, as the form did. A missing or mistyped field, such
// as the string "false" for a switch, decodes to nothing.
const decodeSettingsDraft = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    email: Schema.String,
    defaultContract: Schema.String,
    paymentTerms: Schema.Finite,
    alertsOn: Schema.Boolean,
    threshold: Schema.String,
    weeklyReport: Schema.Boolean,
  })
);

/**
 * Save the settings form, and say what it set in the visitor's language: a server action returns translated text. The
 * example keeps nothing; an app sends the settings to its API here.
 *
 * @param input - The form's draft, as the form sends it. Anyone can post anything to an action, whatever its type says,
 *   so it is decoded as unknown input and parsed here again.
 * @returns The settings saved and one sentence that says what they set, or that the draft holds a field to fix.
 */
export async function saveSettings(input: SettingsDraft): Promise<SaveOutcome> {
  const intl = await getIntl();
  const draft = Option.getOrUndefined(decodeSettingsDraft(input));
  const parsed = draft === undefined ? undefined : parseSettings(draft);

  if (parsed === undefined || parsed._tag === "err") {
    return { _tag: "Invalid", message: intl.t("These settings were not saved: a field needs fixing.") };
  }

  const settings = parsed.value;
  const message = intl.t(
    "Saved: {contract} by default, {days}-day terms, {alerts, select, on {price alerts above {ore, number} øre/kWh} other {no price alerts}} and {report, select, on {a weekly report} other {no weekly report}}.",
    {
      contract: intl.t.from(CONTRACT_LABELS[settings.defaultContract]),
      days: String(settings.paymentTerms),
      alerts: settings.alerts._tag === "Above" ? "on" : "off",
      ore: settings.alerts._tag === "Above" ? settings.alerts.ore : 0,
      report: settings.weeklyReport ? "on" : "off",
    }
  );

  return { _tag: "Saved", settings, message };
}
