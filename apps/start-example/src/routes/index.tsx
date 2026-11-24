// The overview, ported from Fuse's app-shell block (overview-page.tsx at Fuse 9be80460): four key figures, the month's
// consumption against last year, today's spot price by the quarter-hour, a year of consumption against solar
// production, and the latest activity. Above them, a welcome and February's invoices: `<T>` with values, plurals,
// selects and tags, `useIntl()`, `t.from` and the formats, rendered on the server for the first response and hydrated
// with the same text, and a notice the route's loader translated on the server. Every date and time the page shows,
// the charts' labels included, comes formatted from the loader too (see src/server/portal.functions.ts).
import { createFileRoute, Link } from "@tanstack/react-router";

import { Badge } from "@elmeragroup/fuse/badge";
import { Button } from "@elmeragroup/fuse/button";
import { BarChart, Chart, LineChart } from "@elmeragroup/fuse/chart";
import type { ChartConfig, ValueFormat } from "@elmeragroup/fuse/chart";
import { DescriptionList } from "@elmeragroup/fuse/description-list";
import { Frame } from "@elmeragroup/fuse/frame";
import { TimelineList } from "@elmeragroup/fuse/timeline-list";
import { Plural, Select, T, useFormat, useIntl, useT, Val } from "@elmeragroup/intl/react";

import { APP_PAGE_BY_ID, EXACT_MATCH } from "../components/app-config";
import { KpiCard } from "../components/kpi-card";
import { PageHeader } from "../components/page-header";
import { INVOICE_STATE_COUNTS, INVOICE_STATE_TAGS, OVERDUE_COUNT } from "../data/invoice-run";
import type { InvoiceStateTag } from "../data/invoice-run";
import { PRICE_AREAS } from "../data/market";
import {
  AS_OF,
  COMPLETE_DAYS,
  DAILY_CONSUMPTION,
  DAILY_INVOICING,
  DAILY_SOLAR,
  INVOICES,
  priceLevel,
  SPOT_30_DAY_AVERAGE,
  SPOT_TODAY,
  spotAt,
} from "../data/power-data";
import { SIGNED_IN } from "../data/signed-in";
import { fuseLocale } from "../intl/locale";
import { INVOICE_STATE_LABELS, PRICE_LEVEL_LABELS } from "../intl/messages";
import { getOverviewLoaderData } from "../server/portal.functions";

const MWH = { preset: "energy", unit: "MWh", maximumFractionDigits: 1 } as const satisfies ValueFormat;
const SPOT = {
  preset: "unit-price",
  currency: "NOK",
  minor: true,
  vat: "excluded",
  maximumFractionDigits: 1,
} as const satisfies ValueFormat;
const KR = {
  style: "currency",
  currency: "NOK",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
} as const satisfies ValueFormat;

const LEVEL_BADGES = { low: "soft-success", normal: "secondary", high: "soft-warning" } as const;

const STATE_BADGES = {
  Paid: "soft-success",
  Open: "soft-info",
  Overdue: "soft-destructive",
  Credited: "muted",
} as const satisfies Readonly<Record<InvoiceStateTag, string>>;

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

// The month so far: every day whose readings are in.
const complete = DAILY_CONSUMPTION.slice(0, COMPLETE_DAYS);
const consumed = sum(complete.map((day) => day.thisYear ?? 0));
const consumedLastYear = sum(complete.map((day) => day.lastYear));
const solar = sum(DAILY_SOLAR.map((day) => day.thisYear));
const solarLastYear = sum(DAILY_SOLAR.map((day) => day.lastYear));
const spotNow = spotAt(AS_OF)?.price ?? SPOT_30_DAY_AVERAGE;
const spotSoFar = SPOT_TODAY.filter((quarter) => quarter.start <= AS_OF).map((quarter) => quarter.price);

// February's invoices: what they charged, when they fall due and how many are in each state.
const invoiced = sum(INVOICES.map((invoice) => invoice.total));
const stateCounts = INVOICE_STATE_TAGS.map((tag) => ({ tag, count: INVOICE_STATE_COUNTS[tag] }));

/** `/`: the overview. */
export const Route = createFileRoute("/")({
  // Its data is text in the visitor's language. Cached from an earlier visit, it would show in that visit's language
  // while it reloads, so a return after a locale switch waits for the reload instead: the page never paints the old
  // language.
  loader: { handler: () => getOverviewLoaderData(), staleReloadMode: "blocking" },
  component: OverviewPage,
});

function OverviewPage() {
  // Every date the page shows, formatted on the server: see src/server/portal.functions.ts.
  const { notice, asOf, sent, due, activity, months, spotLabel, charts } = Route.useLoaderData();
  const t = useT();
  const format = useFormat();
  // The whole instance: its locale for Fuse's chart values, and its `t`, the translator `useT()` returns.
  const intl = useIntl();
  const locale = fuseLocale(intl.locale);
  const page = APP_PAGE_BY_ID.overview;
  const level = priceLevel(spotNow);

  const dailyConfig = {
    thisYear: { label: months.thisYear, color: "chart-1", format: MWH },
    // Last year is the comparison: a line in the neutral role over this year's bars, so this year leads.
    lastYear: { label: months.lastYear, color: "chart-other", format: MWH },
  } as const satisfies ChartConfig;
  const spotConfig = {
    price: { label: t("Spot price, NO1"), color: "chart-1", format: SPOT },
    average: { label: t("30-day average"), color: "chart-other", format: SPOT },
  } as const satisfies ChartConfig;
  const energyConfig = {
    consumption: { label: t("Consumption"), color: "chart-1", format: MWH },
    production: { label: t("Solar production"), color: "chart-3", format: MWH },
  } as const satisfies ChartConfig;

  return (
    <>
      <PageHeader title={intl.t.from(page.label)} description={intl.t.from(page.description)}>
        <p className="text-sm text-muted-foreground tabular-nums" id="as-of">
          <T>
            Data as of{" "}
            <time dateTime={AS_OF.toISOString()}>
              <Val asOf={asOf} />
            </time>
          </T>
        </p>
      </PageHeader>
      <div className="md:gap-6 md:px-6 md:pb-8 flex flex-col gap-4 p-4">
        <div className="md:gap-6 grid gap-4 min-[80rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2 id="welcome-heading">
                  <T>Welcome back</T>
                </h2>
              </Frame.Title>
              {/* Translated on the server, in the route's loader (getOverviewLoaderData). */}
              <Frame.Description id="loader-notice">{notice}</Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex flex-col gap-2 text-sm">
              <p id="welcome-invoices">
                <T>
                  Hello <Val name={SIGNED_IN.firstName} />, you have{" "}
                  <Plural
                    count={OVERDUE_COUNT}
                    _0="no overdue invoices"
                    one="# overdue invoice"
                    other="# overdue invoices"
                  />
                  .
                </T>
              </p>
              <p id="welcome-alerts">
                <T>
                  Price alerts go to your <Select channel="email" _email="email" _sms="phone" other="app" />.
                </T>
              </p>
              <p id="welcome-link">
                <T>
                  Review{" "}
                  <Link to={APP_PAGE_BY_ID.invoices.href} activeOptions={EXACT_MATCH}>
                    February's invoices
                  </Link>{" "}
                  before they fall due.
                </T>
              </p>
            </Frame.Panel>
          </Frame.Root>

          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2 id="run-heading">
                  <T>February invoices</T>
                </h2>
              </Frame.Title>
              <Frame.Description>
                <T>The month's invoice run, as it stands.</T>
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex flex-col gap-4">
              <DescriptionList.Root>
                <DescriptionList.Content>
                  <DescriptionList.Item>
                    <DescriptionList.Term>{t("Sent")}</DescriptionList.Term>
                    <DescriptionList.Details id="run-sent">{sent}</DescriptionList.Details>
                  </DescriptionList.Item>
                  <DescriptionList.Item>
                    <DescriptionList.Term>{t("Due")}</DescriptionList.Term>
                    <DescriptionList.Details id="run-due">{due}</DescriptionList.Details>
                  </DescriptionList.Item>
                  <DescriptionList.Item>
                    <DescriptionList.Term>{t("Invoiced")}</DescriptionList.Term>
                    <DescriptionList.Details id="run-total">
                      {format.number(invoiced, "price")}
                    </DescriptionList.Details>
                  </DescriptionList.Item>
                  <DescriptionList.Item>
                    <DescriptionList.Term>{t("Price areas")}</DescriptionList.Term>
                    <DescriptionList.Details id="run-areas">
                      {format.list(PRICE_AREAS, { type: "conjunction" })}
                    </DescriptionList.Details>
                  </DescriptionList.Item>
                </DescriptionList.Content>
              </DescriptionList.Root>
              <div className="flex flex-wrap items-center gap-2" id="run-states">
                {stateCounts.map(({ tag, count }) => (
                  <Badge key={tag} size="sm" variant={STATE_BADGES[tag]} data-invoice-state={tag}>
                    {t.from(INVOICE_STATE_LABELS[tag])} {format.number(count)}
                  </Badge>
                ))}
                {/* "Open" the verb; the badge before it is "Open" the state. One English word, two translations: the
                    context keys each apart. */}
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto"
                  id="run-open"
                  // A link that looks like a button, as Fuse's Button renders one.
                  nativeButton={false}
                  render={<Link to={APP_PAGE_BY_ID.invoices.href} activeOptions={EXACT_MATCH} />}>
                  <T context="verb">Open</T>
                </Button>
              </div>
            </Frame.Panel>
          </Frame.Root>
        </div>

        <section
          aria-labelledby="key-figures"
          className="grid gap-4 min-[40rem]:grid-cols-2 min-[80rem]:grid-cols-4">
          <h2 id="key-figures" className="sr-only">
            <T>Key figures</T>
          </h2>
          <KpiCard
            id="kpi-consumption-change"
            label={t("Consumption, March 1–28")}
            value={consumed}
            format={MWH}
            locale={locale}
            change={{
              value: (consumed - consumedLastYear) / consumedLastYear,
              text: t("{change, number, change} against last year", {
                change: (consumed - consumedLastYear) / consumedLastYear,
              }),
            }}
            trend={complete.map((day) => day.thisYear)}
            trendLabel={t("Consumption per day, March 1 to 28")}
            trendVariant="bar"
          />
          <KpiCard
            id="kpi-spot-change"
            label={t("Spot price now, NO1, excl. VAT")}
            // The figure without the VAT basis, which its label carries: one message, the number and its unit.
            figure={t("{price, number, spot}\u00A0øre/kWh", { price: spotNow })}
            value={spotNow}
            format={SPOT}
            locale={locale}
            badge={
              <Badge size="sm" variant={LEVEL_BADGES[level]}>
                {t.from(PRICE_LEVEL_LABELS[level])}
              </Badge>
            }
            change={{
              value: (spotNow - SPOT_30_DAY_AVERAGE) / SPOT_30_DAY_AVERAGE,
              text: t("{change, number, change} against the 30-day average", {
                change: (spotNow - SPOT_30_DAY_AVERAGE) / SPOT_30_DAY_AVERAGE,
              }),
            }}
            trend={spotSoFar}
            trendLabel={t("Spot price per quarter-hour today, so far")}
          />
          <KpiCard
            id="kpi-invoicing-note"
            label={t("Estimated invoicing, March")}
            value={sum(DAILY_INVOICING)}
            format={KR}
            locale={locale}
            note={t("Spot plus markup, VAT included")}
            trend={DAILY_INVOICING}
            trendLabel={t("Estimated invoicing per day, March 1 to 28")}
            trendVariant="bar"
          />
          <KpiCard
            id="kpi-solar-change"
            label={t("Solar production, March 1–28")}
            value={solar}
            format={MWH}
            locale={locale}
            change={{
              value: (solar - solarLastYear) / solarLastYear,
              text: t("{change, number, change} against last year", {
                change: (solar - solarLastYear) / solarLastYear,
              }),
            }}
            trend={DAILY_SOLAR.map((day) => day.thisYear)}
            trendLabel={t("Solar production per day, March 1 to 28")}
            trendVariant="bar"
          />
        </section>

        <div className="md:gap-6 grid gap-4 min-[80rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2>
                  <T>Consumption per day</T>
                </h2>
              </Frame.Title>
              <Frame.Description>
                <T>March so far, against March last year, across every metering point.</T>
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex-1">
              <BarChart.Root
                data={charts.daily}
                config={dailyConfig}
                xKey="day"
                style={{ "--chart-plot-height": "15rem" }}
                aria-label={t("Consumption per day, March 2026 against March 2025")}>
                <BarChart.Grid />
                <BarChart.YAxis />
                <BarChart.XAxis />
                <BarChart.Bar dataKey="thisYear" />
                <BarChart.Line dataKey="lastYear" />
                <BarChart.Crosshair />
                <BarChart.Tooltip />
                <BarChart.LegendToggleGroup />
                <BarChart.Table />
              </BarChart.Root>
            </Frame.Panel>
          </Frame.Root>

          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2>
                  <T>Spot price today</T>
                </h2>
              </Frame.Title>
              <Frame.Description>
                <T>NO1 by the quarter-hour, against the 30-day average.</T>
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex-1">
              <LineChart.Root
                data={charts.spot}
                config={spotConfig}
                xKey="start"
                yBaseline="none"
                style={{ "--chart-plot-height": "15rem" }}
                aria-label={spotLabel}>
                <LineChart.Grid />
                <LineChart.YAxis />
                <LineChart.XAxis />
                <LineChart.Line dataKey="average" variant="dashed" />
                <LineChart.Line dataKey="price" curve="step-after" />
                <LineChart.Marker dataKey="price" at={{ x: charts.spotNow }} variant="halo" />
                <LineChart.Marker dataKey="price" at="max">
                  <LineChart.ValueLabel />
                </LineChart.Marker>
                <LineChart.Crosshair />
                <LineChart.ActiveDot dataKey="price" />
                <LineChart.Tooltip />
                <LineChart.Legend />
                <LineChart.Table />
              </LineChart.Root>
            </Frame.Panel>
          </Frame.Root>
        </div>

        <div className="md:gap-6 grid gap-4 min-[80rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2>
                  <T>Consumption and solar production</T>
                </h2>
              </Frame.Title>
              <Frame.Description>
                <T>The last twelve months. Heating peaks in winter, and the prosumers' solar in summer.</T>
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex-1">
              <Chart.Root
                data={charts.monthly}
                config={energyConfig}
                xKey="month"
                aria-label={t("Consumption and solar production per month, March 2025 to February 2026")}>
                <Chart.Panel series={["consumption"]}>
                  <Chart.Grid />
                  <Chart.YAxis />
                  <Chart.Crosshair variant="line" />
                  <Chart.Area dataKey="consumption" />
                  <Chart.Line dataKey="consumption" />
                </Chart.Panel>
                <Chart.Panel series={["production"]}>
                  <Chart.Grid />
                  <Chart.YAxis />
                  <Chart.Crosshair variant="line" />
                  <Chart.Area dataKey="production" />
                  <Chart.Line dataKey="production" />
                  <Chart.XAxis />
                </Chart.Panel>
                <Chart.Tooltip />
                <Chart.Legend />
                <Chart.Table />
              </Chart.Root>
            </Frame.Panel>
          </Frame.Root>

          <Frame.Root>
            <Frame.Header>
              <Frame.Title>
                <h2>
                  <T>Activity</T>
                </h2>
              </Frame.Title>
              <Frame.Description>
                <T>The latest from billing, metering and the market.</T>
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="flex-1">
              <TimelineList.Root>
                {activity.map((entry) => (
                  <TimelineList.Item key={entry.id} data-activity={entry.id}>
                    <TimelineList.Title level={3}>{entry.title}</TimelineList.Title>
                    {/* Measured on the server from the dashboard's moment, AS_OF. */}
                    <TimelineList.Time date={new Date(entry.at)}>{entry.ago}</TimelineList.Time>
                    <TimelineList.Description>{entry.detail}</TimelineList.Description>
                  </TimelineList.Item>
                ))}
              </TimelineList.Root>
            </Frame.Panel>
          </Frame.Root>
        </div>
      </div>
    </>
  );
}
