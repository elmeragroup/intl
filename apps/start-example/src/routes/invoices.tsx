// Invoices: the page's header and February's figures, then the table and its Sheet (src/components/invoices-table.tsx).
// Every date the page shows, the billing period, the due dates and the table's due cells, is formatted on the server in
// the route's loader (getInvoicesLoaderData), which sends the table its rows.
import { createFileRoute } from "@tanstack/react-router";

import { DescriptionList } from "@elmeragroup/fuse/description-list";
import { useT } from "@elmeragroup/intl/react";

import { APP_PAGE_BY_ID } from "../components/app-config";
import { InvoicesTable } from "../components/invoices-table";
import { PageHeader } from "../components/page-header";
import { getInvoicesLoaderData } from "../server/portal.functions";

/** `/invoices`: February's invoices. */
export const Route = createFileRoute("/invoices")({
  // Its data is text in the visitor's language. Cached from an earlier visit, it would show in that visit's language
  // while it reloads, so a return after a locale switch waits for the reload instead: the page never paints the old
  // language.
  loader: { handler: () => getInvoicesLoaderData(), staleReloadMode: "blocking" },
  component: InvoicesPage,
});

function InvoicesPage() {
  const { period, due, rows } = Route.useLoaderData();
  const invoiced = rows.reduce((total, invoice) => total + invoice.total, 0);
  const t = useT();
  const page = APP_PAGE_BY_ID.invoices;

  return (
    <>
      <PageHeader title={t.from(page.label)} description={t.from(page.description)} />
      <div className="md:px-6 px-4 pt-2">
        <DescriptionList.Root>
          <DescriptionList.Content>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Billing period")}</DescriptionList.Term>
              {/* Formatted in the loader, as the due dates are: see getInvoicesLoaderData. */}
              <DescriptionList.Details id="invoices-period">{period}</DescriptionList.Details>
            </DescriptionList.Item>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Invoiced")}</DescriptionList.Term>
              <DescriptionList.Details id="invoices-total">
                {t("{count, plural, one {# invoice} other {# invoices}} for {total, number, price}", {
                  count: rows.length,
                  total: invoiced,
                })}
              </DescriptionList.Details>
            </DescriptionList.Item>
            <DescriptionList.Item>
              <DescriptionList.Term>{t("Due")}</DescriptionList.Term>
              <DescriptionList.Details id="invoices-due">{due}</DescriptionList.Details>
            </DescriptionList.Item>
          </DescriptionList.Content>
        </DescriptionList.Root>
      </div>
      <InvoicesTable rows={rows} />
    </>
  );
}
