// Type-level contract of the API's generated client: the type-check runs these lines, nothing executes them. A client
// built from the contract alone passes the invoice number the API answers with, from an invoice and from the 404, back
// to `GET /invoices/:id`, whose path parameter is an `InvoiceNumber`. An answer that wrote either as a plain string
// would fail this file, and so would a path parameter that took one: a raw string is not an `InvoiceId`.
import * as Effect from "effect/Effect";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";

import type { Api } from "../src/api.ts";
import type { InvoiceId } from "../src/invoice-number.ts";

/** Fetches an invoice, then fetches it again by the number it answered with, or by the number its 404 names. */
export const roundTrip = (client: HttpApiClient.ForApi<typeof Api>, id: InvoiceId) =>
  Effect.gen(function* () {
    const invoice = yield* client.portal.invoice({ params: { id }, query: { lang: "nb" } });

    return yield* client.portal.invoice({ params: { id: invoice.id }, query: {} });
  }).pipe(
    Effect.catchTag("UnknownInvoice", (error) =>
      client.portal.invoice({ params: { id: error.invoiceId }, query: {} })
    )
  );

/** Passes a raw string as the invoice's number, which the client rejects: only a parsed `InvoiceId` reaches the path. */
export const rawNumber = (client: HttpApiClient.ForApi<typeof Api>) =>
  // @ts-expect-error a raw string is not an `InvoiceId`: parse it with `InvoiceNumber` first
  client.portal.invoice({ params: { id: "INV-2026-0215" }, query: {} });
