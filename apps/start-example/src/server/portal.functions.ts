// Server functions that answer with translated text. Each handler builds its translator from its own request,
// `createIntl(await loadIntlConfig(...))` in the handler itself: extraction traces a translator only to a factory call
// in the same file.
//
// The loaders also format every date and time their page shows, the sentences that hold one included. A route's
// component renders twice, on the server and again in the browser as the page hydrates, and Node's ICU and the
// browser's can write one value two ways: English "Mar 29, 2026, 1:20 PM" in Node against "Mar 29, 2026 at 1:20 PM"
// in WebKit, Bokmål "for 2 døgn siden" against "for 2 dager siden". A mismatch makes React throw the server's HTML away
// and render the page again. Loader data reaches the browser as the server made it, so a string formatted here
// hydrates as the very text the server rendered: server and client agree by construction. Numbers, plurals and
// selects, which engines write alike, stay with the components.
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

import { createIntl } from "@elmeragroup/intl/core";
import { loadIntlConfig } from "@elmeragroup/intl/start";

import { overviewCharts } from "../components/overview-charts";
import { osloMidnight } from "../data/market";
import type { Activity } from "../data/power-data";
import { ACTIVITY, AS_OF, BILLING_PERIOD, INVOICES, INVOICES_ISSUED_ON } from "../data/power-data";
import { parseSettings } from "../data/settings";
import type { SaveOutcome, SettingsDraft } from "../data/settings";
import { SettingsDraftSchema } from "../data/settings-draft";
import { adapter } from "../intl/adapter";
import { LOCALIZED_CACHE_CONTROL } from "../intl/locale";
import { CONTRACT_LABELS } from "../intl/messages";

// What an activity entry says: its title and the sentence under it.
type ActivityText = { readonly title: string; readonly detail: string };

// A month and its year, as the daily chart's legend names them: "March 2026".
const MONTH = { month: "long", year: "numeric" } as const;

// When February's invoices fall due: the earliest due date of the run.
const FIRST_DUE = INVOICES.map((invoice) => invoice.dueOn).toSorted(
  (left, right) => left.getTime() - right.getTime()
)[0];

/**
 * What the overview's loader fetches: a notice translated on the server before the route renders, and every date the
 * page shows, formatted here (see the module's comment): the dashboard's moment, the invoice run's age and due date,
 * the activity's sentences and ages, the chart legends' months and every chart's x labels.
 */
export const getOverviewLoaderData = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", LOCALIZED_CACHE_CONTROL);
  const intl = createIntl(await loadIntlConfig(adapter, getRequest()));

  // One sentence per kind of activity, so a translator orders its figures and dates.
  function activityText(entry: Activity): ActivityText {
    switch (entry._tag) {
      case "PriceAlert":
        return {
          title: intl.t("Evening price peak in NO1"),
          detail: intl.t(
            "Spot passes {ore, number} øre/kWh at {at, time, hourMinute}. Price alerts went to {customers, plural, one {# customer} other {# customers}}.",
            { ore: entry.ore, at: new Date("2026-03-29T19:00:00+02:00"), customers: entry.customers }
          ),
        };
      case "Readings":
        return {
          title: intl.t("Readings for {day, date, short} are in", { day: entry.day }),
          detail: intl.t("Elhub delivered a reading for every point we supplied that day."),
        };
      case "MoveIn":
        return {
          title: intl.t("{customers, plural, one {# customer moved in} other {# customers moved in}}", {
            customers: entry.customers,
          }),
          detail: intl.t(
            "Supply starts on {startsOn, date, short} for {later, number} of them, and at once for {now, number}.",
            {
              startsOn: entry.startsOn,
              later: entry.later,
              now: entry.customers - entry.later,
            }
          ),
        };
      case "Payments":
        return {
          title: intl.t("Payments matched"),
          detail: intl.t(
            "{paid, plural, one {# February invoice is paid} other {# February invoices are paid}}. {overdue, plural, one {# is overdue} other {# are overdue}}.",
            { paid: entry.paid, overdue: entry.overdue }
          ),
        };
      case "InvoiceRun":
        return {
          title: intl.t("February invoices sent"),
          detail: intl.t(
            "{invoices, plural, one {# invoice} other {# invoices}}, due {dueOn, date, short}, and {directDebitDueOn, date, short} for direct debit.",
            { invoices: entry.invoices, dueOn: entry.dueOn, directDebitDueOn: entry.directDebitDueOn }
          ),
        };
    }
  }

  return {
    notice: intl.t("This notice was translated in a route loader."),
    asOf: intl.format.dateTime(AS_OF, { dateStyle: "medium", timeStyle: "short" }),
    // Measured from the dashboard's moment, AS_OF, never the clock.
    sent: intl.format.relativeTime(INVOICES_ISSUED_ON, AS_OF),
    due: FIRST_DUE === undefined ? "" : intl.t("Due on {dueOn, date, short}", { dueOn: FIRST_DUE }),
    activity: ACTIVITY.map((entry) => ({
      id: entry.id,
      at: entry.at.toISOString(),
      ago: intl.format.relativeTime(entry.at, AS_OF),
      ...activityText(entry),
    })),
    months: {
      thisYear: intl.format.dateTime(osloMidnight(2026, 2, 1), MONTH),
      lastYear: intl.format.dateTime(osloMidnight(2025, 2, 1), MONTH),
    },
    spotLabel: intl.t("Spot price in NO1 per quarter-hour, {day, date, short}", { day: AS_OF }),
    charts: overviewCharts(intl.format),
  };
});

// Every due date of the run, once each, earliest first.
const DUE_DATES = [...new Set(INVOICES.map((invoice) => invoice.dueOn.getTime()))]
  .toSorted((left, right) => left - right)
  .map((time) => new Date(time));

/**
 * What the invoices route's loader fetches: every date the page shows, formatted on the server (see the module's
 * comment). The billing period is a date range, whose spacing also differs between ICU releases (in English, Node
 * 24's ICU 78.2 uses U+2009 and U+202F where Node 26 and Chromium put plain spaces).
 */
export const getInvoicesLoaderData = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", LOCALIZED_CACHE_CONTROL);
  const intl = createIntl(await loadIntlConfig(adapter, getRequest()));
  const first = DUE_DATES[0];
  const last = DUE_DATES.at(-1);

  return {
    // In the configured zone, Europe/Oslo, wherever the server runs.
    period: intl.format.dateTimeRange(BILLING_PERIOD.from, BILLING_PERIOD.until, {
      month: "long",
      day: "numeric",
    }),
    due:
      first === undefined || last === undefined
        ? ""
        : intl.t("Between {first, date, short} and {last, date, short}", { first, last }),
    // The table's rows: each invoice with its due cell's text beside the date it sorts by.
    rows: INVOICES.map((invoice) => ({ ...invoice, dueLabel: intl.format.dateTime(invoice.dueOn, "short") })),
  };
});

/**
 * Save the settings form, and say what it set in the visitor's language: a server function returns translated text.
 * The example keeps nothing; an app sends the settings to its API here. The draft crossed the network, so it is
 * decoded and parsed again here, whatever the form checked.
 */
export const saveSettings = createServerFn({ method: "POST" })
  // The draft as the network delivers it: any JSON, whatever the caller's types said. Its shape is parsed here, then
  // `parseSettings` parses its fields, as the form did.
  .validator((draft: SettingsDraft): SettingsDraft | undefined => {
    const parsed = SettingsDraftSchema.safeParse(draft);

    return parsed.success ? parsed.data : undefined;
  })
  .handler(async ({ data: draft }): Promise<SaveOutcome> => {
    const intl = createIntl(await loadIntlConfig(adapter, getRequest()));
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
  });
