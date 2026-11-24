// The API's contract, schema first: each endpoint's path, the query or path parameters it decodes, the body it answers
// and the errors it can fail with, and the middleware every endpoint runs under. Contract only: it imports effect's
// schema and HTTP API modules, the runtime's `CurrentIntl` type and one portable module of its own, the invoice number,
// so a client, the OpenAPI document or a test takes it alone (`.oxlintrc.json` holds that).
// The handlers live in handlers.ts; the middleware's implementation in intl/intl-middleware.ts; server.ts wires them.
import * as ErrorReporter from "effect/ErrorReporter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as Schema from "effect/Schema";

import type { CurrentIntl } from "@elmeragroup/intl/effect";

import { InvoiceNumber } from "./invoice-number.ts";

/** A sentence in the request's language. */
export const Message = Schema.Struct({ message: Schema.String });

/** An invoice as the API writes it: every field text in the request's language. */
export const InvoiceText = Schema.Struct({
  /** The invoice's number, which a client passes back to `GET /invoices/:id`. */
  id: InvoiceNumber,
  customer: Schema.String,
  /** The status's label. */
  status: Schema.String,
  /** The amount in kroner, as the locale writes money. */
  amount: Schema.String,
  /** The due date, in a sentence. */
  due: Schema.String,
  /** The period the invoice bills, as a date range. */
  period: Schema.String,
  /** How the invoice reached the customer. */
  delivery: Schema.String,
  /** How long ago the invoice went out, from the API's fixed moment. */
  sent: Schema.String,
});

/**
 * The 400 a request answers when its path, query or headers do not decode: why, in the request's language. A client's
 * mistake, so error reporting ignores it.
 */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  {
    /** What went wrong, in the request's language. */
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {
  /** An expected client error, never reported. */
  override readonly [ErrorReporter.ignore] = true;
}

/**
 * The 404 a request for an unknown invoice answers: the number asked for, and why, in the request's language. A
 * client's mistake, so error reporting ignores it.
 */
export class UnknownInvoice extends Schema.TaggedError<UnknownInvoice>()(
  "UnknownInvoice",
  {
    /** The number asked for. */
    invoiceId: InvoiceNumber,
    /** What went wrong, in the request's language. */
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {
  /** An expected client error, never reported. */
  override readonly [ErrorReporter.ignore] = true;
}

/**
 * Provides `CurrentIntl` to every endpoint of the group it is added to, for the request's language, and fails a
 * request that does not decode with `InvalidRequest`. Its implementation is `IntlMiddleware.layer` in
 * intl/intl-middleware.ts.
 */
export class IntlMiddleware extends HttpApiMiddleware.Service<IntlMiddleware, { provides: CurrentIntl }>()(
  "effect-example/IntlMiddleware",
  { error: InvalidRequest }
) {}

/**
 * The query parameter that picks the locale over Accept-Language, as `?lang=nb`. A query parameter, not a cookie or a
 * header: an API client sets it per call without state, and a cache already keys on the URL, so `Vary` needs no entry
 * for it. The intl middleware reads it by this name.
 */
export const LOCALE_PARAMETER = "lang";

// The `lang` override every endpoint takes, as `?lang=sv`: optional, and any text, so a language the API does not
// ship, or the parameter given twice, falls back to Accept-Language instead of failing the request. The middleware
// reads it; declared here so the OpenAPI document and a typed client name it.
const LANGUAGE_QUERY = {
  [LOCALE_PARAMETER]: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description:
      "The language to answer in (en, nb, sv or fi), over Accept-Language. Another value, or the parameter given more than once, falls back to Accept-Language.",
  }),
} as const;

/** The portal's endpoints. */
export class PortalGroup extends HttpApiGroup.make("portal")
  .add(
    // `GET /greeting?name=Ingrid`: a placeholder.
    HttpApiEndpoint.get("greeting", "/greeting", {
      query: { name: Schema.NonEmptyString, ...LANGUAGE_QUERY },
      success: Message,
    }),
    // `GET /overdue?count=6`: an ICU plural.
    HttpApiEndpoint.get("overdue", "/overdue", {
      query: { count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), ...LANGUAGE_QUERY },
      success: Message,
    }),
    // `GET /invoices/INV-2026-0215`: a msg() label, money, dates, a range, a select, a relative time and a typed error.
    HttpApiEndpoint.get("invoice", "/invoices/:id", {
      params: { id: InvoiceNumber },
      query: LANGUAGE_QUERY,
      success: InvoiceText,
      error: UnknownInvoice,
    })
  )
  .middleware(IntlMiddleware) {}

/** The API: one group, served by server.ts. */
export class Api extends HttpApi.make("effect-example").add(PortalGroup) {}
