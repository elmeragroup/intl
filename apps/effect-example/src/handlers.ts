// The portal's handlers. Each reads the request's translator as a service, `const { t, format } = yield* CurrentIntl`,
// which the intl middleware provides per request, and answers text in the request's language. A handler never chooses
// a locale or loads a catalog: it only translates and formats.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { CurrentIntl } from "@elmeragroup/intl/effect";

import { Api, UnknownInvoice } from "./api.ts";
import { AS_OF, findInvoice } from "./data/invoices.ts";
import { INVOICE_STATUS_LABELS } from "./intl/messages.ts";

/** The handlers of the portal group, each over the request's `CurrentIntl`. */
export const PortalHandlers = HttpApiBuilder.group(Api, "portal", (handlers) =>
  handlers.handleAll({
    // A placeholder: the name is the caller's, the sentence around it the locale's.
    greeting: Effect.fn(function* ({ query }) {
      const { t } = yield* CurrentIntl;

      return { message: t("Hello {name}, welcome back.", { name: query.name }) };
    }),

    // An ICU plural: each language's own forms of the count, an exact `=0` among them.
    overdue: Effect.fn(function* ({ query }) {
      const { t } = yield* CurrentIntl;

      return {
        message: t(
          "{count, plural, =0 {No invoices are overdue} one {# invoice is overdue} other {# invoices are overdue}}.",
          { count: query.count }
        ),
      };
    }),

    // One invoice, all of it text: a msg() label, money in the locale's format, a date in a sentence, a date range
    // and a relative time in the market's zone, and a select. An unknown number is the lookup's typed error, mapped
    // here to the 404's body in the request's language.
    invoice: Effect.fn(function* ({ params }) {
      const { t, format } = yield* CurrentIntl;
      const invoice = yield* findInvoice(params.id).pipe(
        Effect.mapError(
          (error) =>
            new UnknownInvoice({
              invoiceId: error.invoiceId,
              message: t("No invoice has the number {invoiceId}.", { invoiceId: error.invoiceId }),
            })
        )
      );

      return {
        id: invoice.id,
        customer: invoice.customer,
        status: t.from(INVOICE_STATUS_LABELS[invoice.status]),
        amount: format.number(invoice.amount, "price"),
        due: t("Due on {dueOn, date, short}", { dueOn: invoice.dueOn }),
        period: format.dateTimeRange(invoice.period.from, invoice.period.until, {
          month: "long",
          day: "numeric",
        }),
        delivery: t(
          "{channel, select, efaktura {Sent as eFaktura} email {Sent by email} other {Sent by post}}",
          { channel: invoice.channel }
        ),
        // Measured from the API's fixed moment, never the clock.
        sent: format.relativeTime(invoice.issuedOn, AS_OF),
      };
    }),
  })
);
