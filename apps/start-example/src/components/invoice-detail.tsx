// One invoice in the invoices page's Sheet, ported from Fuse's app-shell block (invoices-page.tsx at Fuse 9be80460):
// its customer and contract, its lines, VAT and payment, and a reminder for an overdue one. The Sheet opens on a row's
// press, in the browser, so everything here formats on the client with useFormat(): it never renders on the server, so
// no hydration has to match it, and it formats in the shell's locale and the configured zone.
import { Badge } from "@elmeragroup/fuse/badge";
import { Button } from "@elmeragroup/fuse/button";
import { DescriptionList } from "@elmeragroup/fuse/description-list";
import { PaperPlaneTilt } from "@elmeragroup/fuse/icons";
import { Sheet } from "@elmeragroup/fuse/sheet";
import { Table } from "@elmeragroup/fuse/table";
import { Toast } from "@elmeragroup/fuse/toast";
import { T, useFormat, useT, Val } from "@elmeragroup/intl/react";

import type { InvoiceStateTag } from "../data/invoice-run";
import { VAT_RATE } from "../data/market";
import type { Invoice, InvoiceLine } from "../data/power-data";
import { CONTRACT_LABELS, INVOICE_STATE_LABELS, PRICE_AREA_NAMES } from "../intl/messages";

// Each state's badge tone.
const STATE_BADGES = {
  Paid: "soft-success",
  Open: "soft-info",
  Overdue: "soft-destructive",
  Credited: "muted",
} as const satisfies Readonly<Record<InvoiceStateTag, string>>;

/**
 * An invoice's state as a badge, in the visitor's language.
 *
 * @param props - The state's tag.
 */
export function InvoiceStateBadge({ tag }: { readonly tag: InvoiceStateTag }) {
  const t = useT();

  return (
    <Badge size="sm" variant={STATE_BADGES[tag]}>
      {t.from(INVOICE_STATE_LABELS[tag])}
    </Badge>
  );
}

// One invoice line: what it charged for, and what it counts.
function LineText({ line }: { readonly line: InvoiceLine }) {
  const t = useT();

  switch (line._tag) {
    case "Energy":
      return (
        <>
          <span className="block">
            {t("Energy, {contract}", { contract: t.from(CONTRACT_LABELS[line.contract]) })}
          </span>
          <span className="text-xs block text-muted-foreground tabular-nums">
            {t("{kwh, number} kWh × {price, number} øre", { kwh: line.kwh, price: line.priceOre })}
          </span>
        </>
      );
    case "MonthlyFee":
      return (
        <span className="block">
          <T>Monthly fee</T>
        </span>
      );
  }
}

// What sending a reminder for `invoice` says. Nodes, not strings: a toast outlives a language switch, and `<T>` renders
// in the language the provider has now.
function reminderToast(invoice: Invoice) {
  return {
    type: "success",
    title: <T>Reminder sent</T>,
    description: (
      <T>
        <Val customer={invoice.customer} /> gets a reminder for <Val number={invoice.number} />.
      </T>
    ),
  } as const;
}

/**
 * One invoice in the Sheet: its customer and contract, its lines and what happened to it.
 *
 * @param props - The invoice.
 */
export function InvoiceDetail({ invoice }: { readonly invoice: Invoice }) {
  const t = useT();
  const format = useFormat();
  const toasts = Toast.useToastManager();
  const subtotal = invoice.total - invoice.vat;
  const { state } = invoice;

  return (
    <>
      <Sheet.Header>
        <div className="flex items-center gap-2">
          <Sheet.Title>{invoice.number}</Sheet.Title>
          <InvoiceStateBadge tag={state._tag} />
        </div>
        <Sheet.Description>
          {t("{customer}, February 2026. {total, number, price} due on {dueOn, date, short}.", {
            customer: invoice.customer,
            total: invoice.total,
            dueOn: invoice.dueOn,
          })}
        </Sheet.Description>
      </Sheet.Header>
      <Sheet.Body>
        <div className="flex flex-col gap-6">
          <DescriptionList.Root>
            <DescriptionList.Content>
              <DescriptionList.Item>
                <DescriptionList.Term>
                  <T>Metering point</T>
                </DescriptionList.Term>
                <DescriptionList.Details>
                  <span className="font-mono tabular-nums">{invoice.meteringPointId}</span>
                </DescriptionList.Details>
              </DescriptionList.Item>
              <DescriptionList.Item>
                <DescriptionList.Term>
                  <T>Price area</T>
                </DescriptionList.Term>
                <DescriptionList.Details>
                  {t("{area}, {name}", {
                    area: invoice.priceArea,
                    name: t.from(PRICE_AREA_NAMES[invoice.priceArea]),
                  })}
                </DescriptionList.Details>
              </DescriptionList.Item>
              <DescriptionList.Item>
                <DescriptionList.Term>
                  <T>Contract</T>
                </DescriptionList.Term>
                <DescriptionList.Details>{t.from(CONTRACT_LABELS[invoice.contract])}</DescriptionList.Details>
              </DescriptionList.Item>
              <DescriptionList.Item>
                <DescriptionList.Term>
                  <T>Issued</T>
                </DescriptionList.Term>
                <DescriptionList.Details>
                  {format.dateTime(invoice.issuedOn, "short")}
                </DescriptionList.Details>
              </DescriptionList.Item>
              {state._tag === "Paid" ? (
                <DescriptionList.Item>
                  <DescriptionList.Term>{t.from(INVOICE_STATE_LABELS.Paid)}</DescriptionList.Term>
                  <DescriptionList.Details>{format.dateTime(state.paidOn, "short")}</DescriptionList.Details>
                </DescriptionList.Item>
              ) : null}
              {state._tag === "Credited" ? (
                <DescriptionList.Item>
                  <DescriptionList.Term>
                    <T>Credit note</T>
                  </DescriptionList.Term>
                  <DescriptionList.Details>
                    <span className="font-mono">{state.creditNote}</span>
                  </DescriptionList.Details>
                </DescriptionList.Item>
              ) : null}
            </DescriptionList.Content>
          </DescriptionList.Root>

          <Table.Root>
            <Table.Caption className="sr-only">
              <T>Invoice lines</T>
            </Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>
                  <T>Line</T>
                </Table.Head>
                <Table.Head className="text-right">
                  <T>Amount</T>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {invoice.lines.map((line) => (
                <Table.Row key={line._tag}>
                  <Table.Cell>
                    <LineText line={line} />
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    <span className="tabular-nums">{format.number(line.amount, "price")}</span>
                  </Table.Cell>
                </Table.Row>
              ))}
              <Table.Row>
                <Table.Cell>
                  {invoice.vat === 0
                    ? t("VAT, not charged in Northern Norway")
                    : t("VAT, {rate, number, percent} of {subtotal, number, price}", {
                        rate: VAT_RATE,
                        subtotal,
                      })}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <span className="tabular-nums">{format.number(invoice.vat, "price")}</span>
                </Table.Cell>
              </Table.Row>
            </Table.Body>
            <Table.Footer>
              <Table.Row>
                <Table.Cell>
                  <span className="font-medium">
                    <T>Total</T>
                  </span>
                </Table.Cell>
                <Table.Cell className="text-right">
                  <span className="font-medium tabular-nums">{format.number(invoice.total, "price")}</span>
                </Table.Cell>
              </Table.Row>
            </Table.Footer>
          </Table.Root>
        </div>
      </Sheet.Body>
      {/* One row from sm, the primary action last; stacked full width on a phone. */}
      <Sheet.Footer className="sm:flex-row sm:justify-end">
        <Sheet.Close render={<Button variant="outline" />}>
          <T>Close</T>
        </Sheet.Close>
        {state._tag === "Overdue" ? (
          <Button
            onClick={() => {
              toasts.add(reminderToast(invoice));
            }}>
            <PaperPlaneTilt data-icon="inline-start" />
            <T>Send reminder</T>
          </Button>
        ) : null}
      </Sheet.Footer>
    </>
  );
}
