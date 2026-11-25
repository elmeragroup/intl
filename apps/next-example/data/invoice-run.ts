// February's invoice run in summary: how many invoices it sent and how many are in each state. The sidebar's overdue
// badge, the overview and the invoice filter read these counts, so none of them builds an invoice to count one; the
// invoices themselves (data/power-data.ts) take their states from the same cycle, so the two agree by construction.

/** An invoice state's tag. */
export type InvoiceStateTag = "Paid" | "Open" | "Overdue" | "Credited";

/** Every invoice state, in the order the overview and the filter list them. */
export const INVOICE_STATE_TAGS = [
  "Paid",
  "Open",
  "Overdue",
  "Credited",
] as const satisfies ReadonlyArray<InvoiceStateTag>;

/** How many invoices February's run sent. */
export const INVOICE_COUNT = 72;

/**
 * The states invoices take in turn, by their place in the run: every 12 invoices hold 8 paid, 2 open, 1 overdue and 1
 * credited, so the 72 invoices hold 48 paid, 12 open, 6 overdue and 6 credited.
 */
export const INVOICE_STATE_CYCLE = [
  "Paid",
  "Paid",
  "Open",
  "Paid",
  "Paid",
  "Overdue",
  "Paid",
  "Paid",
  "Open",
  "Paid",
  "Paid",
  "Credited",
] as const satisfies ReadonlyArray<InvoiceStateTag>;

/**
 * The state of the run's invoice at a place.
 *
 * @param index - The invoice's place in the run, the first as 0.
 * @returns Its state's tag.
 */
export function invoiceStateAt(index: number): InvoiceStateTag {
  return INVOICE_STATE_CYCLE[index % INVOICE_STATE_CYCLE.length] ?? "Paid";
}

/** How many invoices are in each state. */
export type InvoiceStateCounts = Readonly<Record<InvoiceStateTag, number>>;

function countStates(): InvoiceStateCounts {
  const counts = { Paid: 0, Open: 0, Overdue: 0, Credited: 0 };
  for (let index = 0; index < INVOICE_COUNT; index += 1) {
    counts[invoiceStateAt(index)] += 1;
  }

  return counts;
}

/** How many of the run's invoices are in each state. */
export const INVOICE_STATE_COUNTS: InvoiceStateCounts = countStates();

/** How many of February's invoices are overdue, which the sidebar counts so they get seen. */
export const OVERDUE_COUNT = INVOICE_STATE_COUNTS.Overdue;
