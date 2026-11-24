"use client";
// Invoices, ported from Fuse's app-shell block (invoices-page.tsx at Fuse 9be80460): February's invoices with a status
// filter, sortable due dates and amounts in kr, and a Sheet with one invoice's lines, VAT and payment
// (components/invoice-detail.tsx). A row press opens the Sheet; the invoice number is a button, so a keyboard
// reaches what the press does. Fuse's currency cells format in its LocaleProvider's locale and zone, which the shell
// takes from the request; each due date arrives formatted, from the server.
import { useCallback, useMemo, useState } from "react";

import {
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_alphanumericCaseSensitive,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  sortFn_textCaseSensitive,
  tableFeatures,
} from "@tanstack/react-table";

import { Button } from "@elmeragroup/fuse/button";
import { createFuseTableHook } from "@elmeragroup/fuse/data-table";
import { Sheet } from "@elmeragroup/fuse/sheet";
import { ToggleGroup } from "@elmeragroup/fuse/toggle-group";
import { T, useFormat, useT } from "@elmeragroup/intl/react";

import { INVOICE_COUNT, INVOICE_STATE_COUNTS } from "../data/invoice-run";
import type { Invoice } from "../data/power-data";
import { INVOICE_STATE_LABELS } from "../intl/messages";
import { InvoiceDetail, InvoiceStateBadge } from "./invoice-detail";

// The status filter's choices: every invoice, or one state.
const SHOWS = ["all", "Open", "Overdue", "Paid", "Credited"] as const;
type Show = (typeof SHOWS)[number];

// How many invoices a choice shows, from the run's summary.
function countOf(choice: Show): number {
  return choice === "all" ? INVOICE_COUNT : INVOICE_STATE_COUNTS[choice];
}

const { useAppTable, createAppColumnHelper } = createFuseTableHook({
  features: tableFeatures({
    rowSortingFeature,
    rowPaginationFeature,
    sortedRowModel: createSortedRowModel(),
    paginatedRowModel: createPaginatedRowModel(),
    // The built-in sorts, registered by name: `sortFn: "datetime"` and the columns' automatic sort pick from these.
    sortFns: {
      alphanumeric: sortFn_alphanumeric,
      alphanumericCaseSensitive: sortFn_alphanumericCaseSensitive,
      basic: sortFn_basic,
      datetime: sortFn_datetime,
      text: sortFn_text,
      textCaseSensitive: sortFn_textCaseSensitive,
    },
  }),
  getRowId: (invoice: InvoiceRow) => invoice.number,
});

/**
 * One row of the table: an invoice, and its due date as the server formatted it. The due cell renders while the page
 * hydrates, and Node's ICU and the browser's can write one date two ways, so the cell shows the server's string; the
 * column sorts by `dueOn`.
 */
export type InvoiceRow = Invoice & {
  /** The due date, formatted on the server in the request's locale and the configured zone. */
  readonly dueLabel: string;
};

const columns = createAppColumnHelper<InvoiceRow>();

// The columns, with the opener the invoice number cell renders. Headers are `<T>`, which needs no translator here.
function invoiceColumns(open: (invoice: InvoiceRow) => void) {
  return columns.columns([
    columns.accessor("number", {
      header: () => <T>Invoice</T>,
      cell: ({ row }) => (
        // A link-styled Button keeps Fuse's focus ring and target size; the number reads in mono. It pulls back by its
        // own inline padding, so the number lines up with the column's header.
        <Button
          variant="link"
          size="xs"
          className="-ms-(--control-px-button-xs)"
          onClick={() => {
            open(row.original);
          }}>
          <span className="text-sm font-mono tabular-nums">{row.original.number}</span>
        </Button>
      ),
    }),
    columns.accessor("customer", {
      header: ({ header }) => (
        <header.SortButton>
          <T>Customer</T>
        </header.SortButton>
      ),
      cell: ({ cell }) => <cell.TextCell />,
    }),
    columns.accessor((invoice) => invoice.state._tag, {
      id: "state",
      header: () => <T>Status</T>,
      cell: ({ row }) => <InvoiceStateBadge tag={row.original.state._tag} />,
    }),
    columns.accessor("dueOn", {
      header: ({ header }) => (
        <header.SortButton>
          <T>Due</T>
        </header.SortButton>
      ),
      sortFn: "datetime",
      cell: ({ row }) => <span className="tabular-nums">{row.original.dueLabel}</span>,
    }),
    columns.accessor("total", {
      // Amounts line up on their last digit, so the header and the figures sit at the end.
      header: ({ header }) => (
        <span className="flex justify-end">
          <header.SortButton>
            <T>Amount</T>
          </header.SortButton>
        </span>
      ),
      cell: ({ cell }) => (
        <span className="block text-right">
          <cell.CurrencyCell currency="NOK" currencyDisplay="narrowSymbol" />
        </span>
      ),
    }),
  ]);
}

/**
 * February's invoices: the status filter, the table and the Sheet a row opens.
 *
 * @param props - The run's invoices, each with its due date formatted on the server.
 */
export function InvoicesTable({ rows }: { readonly rows: ReadonlyArray<InvoiceRow> }) {
  const t = useT();
  const format = useFormat();
  const [show, setShow] = useState<Show>("all");
  // The open invoice, kept while the Sheet animates out so its content does not empty first.
  const [opened, setOpened] = useState<Invoice | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const data = useMemo(
    () => rows.filter((invoice) => show === "all" || invoice.state._tag === show),
    [rows, show]
  );
  const open = useCallback((invoice: InvoiceRow) => {
    setOpened(invoice);
    setSheetOpen(true);
  }, []);
  const tableColumns = useMemo(() => invoiceColumns(open), [open]);
  const table = useAppTable({
    columns: tableColumns,
    data,
    initialState: { pagination: { pageIndex: 0, pageSize: 25 }, sorting: [{ id: "dueOn", desc: false }] },
  });

  return (
    <>
      <div className="md:px-6 flex min-w-0 flex-col gap-3 px-4 pt-2 pb-8">
        <div className="md:mx-0 md:px-0 -mx-4 overflow-x-auto px-4 py-1">
          <ToggleGroup.Root
            aria-label={t("Show invoices")}
            value={[show]}
            onValueChange={(value: Array<string>) => {
              const next = SHOWS.find((choice) => choice === value[0]);
              if (next !== undefined) {
                setShow(next);
              }
            }}>
            {SHOWS.map((choice) => (
              <ToggleGroup.Item key={choice} value={choice}>
                {choice === "all" ? t("All") : t.from(INVOICE_STATE_LABELS[choice])}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {format.number(countOf(choice))}
                </span>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
        <table.AppTable>
          <table.Content aria-label={t("Invoices")}>
            {(row) => (
              <table.Row
                row={row}
                onPress={() => {
                  open(row.original);
                }}
              />
            )}
          </table.Content>
          <table.Pagination pageSizes={[10, 25, 50]} />
        </table.AppTable>
      </div>
      <Sheet.Root open={sheetOpen} onOpenChange={setSheetOpen}>
        <Sheet.Content size="lg">
          {opened === undefined ? null : <InvoiceDetail invoice={opened} />}
        </Sheet.Content>
      </Sheet.Root>
    </>
  );
}
