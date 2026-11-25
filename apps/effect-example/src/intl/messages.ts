// Labels declared once, at module scope, as `msg()` descriptors: the extractor reads them here, and a handler
// translates one per request with `t.from`, in the request's language.
import type { Descriptor } from "@elmeragroup/intl/core";
import { msg } from "@elmeragroup/intl/core";

import type { InvoiceStatus } from "../data/invoices.ts";

/** What an invoice's status reads as. */
export const INVOICE_STATUS_LABELS = {
  paid: msg("Paid"),
  overdue: msg("Overdue"),
  credited: msg("Credited"),
} as const satisfies Readonly<Record<InvoiceStatus, Descriptor>>;
