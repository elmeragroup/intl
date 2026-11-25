// Invoices: the page's header and February's figures render on the server, the table and its Sheet in the browser
// (components/invoices-table.tsx).
import type { Metadata } from "next";

import { DescriptionList } from "@elmeragroup/fuse/description-list";
import { getFormat, getT } from "@elmeragroup/intl/server";

import { APP_PAGE_BY_ID } from "../../components/app-config";
import { InvoicesTable } from "../../components/invoices-table";
import { PageHeader } from "../../components/page-header";
import { BILLING_PERIOD, INVOICES } from "../../data/power-data";

const invoiced = INVOICES.reduce((total, invoice) => total + invoice.total, 0);
const dueDates = INVOICES.map((invoice) => invoice.dueOn.getTime());

/**
 * The document's title, in the request's language.
 *
 * @returns The page's name, which the layout's template follows with the app's.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).from(APP_PAGE_BY_ID.invoices.label) };
}

/** The invoices page. */
export default async function InvoicesPage() {
  const t = await getT();
  const format = await getFormat();
  const page = APP_PAGE_BY_ID.invoices;

  return (
    <>
      <PageHeader title={t.from(page.label)} description={t.from(page.description)} />
      <div className="md:px-6 px-4 pt-2">
        <DescriptionList.Root>
          <DescriptionList.Content>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Billing period")}</DescriptionList.Term>
              {/* A date range formats only here, in a server component: its spacing differs between ICU releases (in
                  English, Node 24's ICU 78.2 uses U+2009 and U+202F where Node 26 and Chromium put plain spaces), so a
                  client component formatting one could hydrate to text that differs from the server's. */}
              <DescriptionList.Details id="invoices-period">
                {format.dateTimeRange(BILLING_PERIOD.from, BILLING_PERIOD.until, {
                  month: "long",
                  day: "numeric",
                })}
              </DescriptionList.Details>
            </DescriptionList.Item>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Invoiced")}</DescriptionList.Term>
              <DescriptionList.Details id="invoices-total">
                {t("{count, plural, one {# invoice} other {# invoices}} for {total, number, price}", {
                  count: INVOICES.length,
                  total: invoiced,
                })}
              </DescriptionList.Details>
            </DescriptionList.Item>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Due")}</DescriptionList.Term>
              <DescriptionList.Details id="invoices-due">
                {t("Between {first, date, short} and {last, date, short}", {
                  first: new Date(Math.min(...dueDates)),
                  last: new Date(Math.max(...dueDates)),
                })}
              </DescriptionList.Details>
            </DescriptionList.Item>
          </DescriptionList.Content>
        </DescriptionList.Root>
      </div>
      {/* Each row with its due cell's text, formatted here on the server, beside the date it sorts by. */}
      <InvoicesTable
        rows={INVOICES.map((invoice) => ({ ...invoice, dueLabel: format.dateTime(invoice.dueOn, "short") }))}
      />
    </>
  );
}
