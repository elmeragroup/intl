// An invoice's number, shared by the API's contract (api.ts), which decodes it from a path and writes it in answers,
// and the invoice data (data/invoices.ts), which is keyed by it. Part of the contract, so it imports nothing local.
import * as Schema from "effect/Schema";

/** Parses an invoice number, `INV-`, the year, `-` and four digits, into an `InvoiceId`. */
export const InvoiceNumber = Schema.String.check(Schema.isPattern(/^INV-\d{4}-\d{4}$/u)).pipe(
  Schema.brand("InvoiceId")
);

/** A parsed invoice number. */
export type InvoiceId = typeof InvoiceNumber.Type;
