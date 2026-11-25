// The invoices the API serves: February's run of a power retailer's invoices, as the host examples' portal bills them.
// Data with no English in it: a status and a delivery channel are keys the API translates, and every instant is fixed,
// so every answer and the tests agree. An app reads these from its billing system.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { InvoiceId } from "../invoice-number.ts";
import { InvoiceNumber } from "../invoice-number.ts";

/** The market's time zone: every date the API writes is a date in Oslo, wherever the server runs. */
export const TIME_ZONE = "Europe/Oslo";

/**
 * The moment the API measures relative times from. Fixed, so an answer reads the same on every call and in the tests;
 * an app passes its clock's `now`.
 */
export const AS_OF = new Date("2026-03-29T13:20:00+02:00");

/** Where an invoice stands. */
export type InvoiceStatus = "paid" | "overdue" | "credited";

/** How an invoice reached the customer. */
export type DeliveryChannel = "efaktura" | "email" | "post";

/** One invoice. */
export type Invoice = {
  readonly id: InvoiceId;
  readonly customer: string;
  readonly status: InvoiceStatus;
  readonly channel: DeliveryChannel;
  /** In kroner; a credit note's is negative. */
  readonly amount: number;
  readonly issuedOn: Date;
  readonly dueOn: Date;
  /** The period the invoice bills, from its first instant to its last. */
  readonly period: { readonly from: Date; readonly until: Date };
};

// February 2026 in Oslo, from its first midnight to its last instant.
const FEBRUARY = {
  from: new Date("2026-02-01T00:00:00+01:00"),
  until: new Date("2026-02-28T23:59:59.999+01:00"),
} as const;

// When the run went out, and when it falls due: midnight in Oslo on 20 March, still 19 March west of Oslo.
const ISSUED_ON = new Date("2026-03-06T09:00:00+01:00");
const DUE_ON = new Date("2026-03-20T00:00:00+01:00");

const INVOICES: ReadonlyArray<Invoice> = [
  {
    id: InvoiceNumber.make("INV-2026-0215"),
    customer: "Kari Nordmann",
    status: "paid",
    channel: "efaktura",
    amount: 1249.5,
    issuedOn: ISSUED_ON,
    dueOn: DUE_ON,
    period: FEBRUARY,
  },
  {
    id: InvoiceNumber.make("INV-2026-0216"),
    customer: "Ola Nordmann",
    status: "overdue",
    channel: "email",
    amount: 2310,
    issuedOn: ISSUED_ON,
    dueOn: DUE_ON,
    period: FEBRUARY,
  },
  {
    id: InvoiceNumber.make("INV-2026-0217"),
    customer: "Ingrid Berg",
    status: "credited",
    channel: "post",
    amount: -412.3,
    issuedOn: ISSUED_ON,
    dueOn: DUE_ON,
    period: FEBRUARY,
  },
];

/** No invoice has the number asked for. Untranslated: the API maps it to a body in the request's language. */
export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()("InvoiceNotFound", {
  /** The number asked for. */
  invoiceId: InvoiceNumber,
}) {}

/**
 * Look an invoice up by its number.
 *
 * @param id - The invoice number.
 * @returns The invoice, or `InvoiceNotFound`.
 */
export function findInvoice(id: InvoiceId): Effect.Effect<Invoice, InvoiceNotFound> {
  const invoice = INVOICES.find((candidate) => candidate.id === id);

  return invoice === undefined
    ? Effect.fail(new InvoiceNotFound({ invoiceId: id }))
    : Effect.succeed(invoice);
}
