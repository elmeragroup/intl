// Messages declared at module scope with msg(): extraction reads them here, and a component renders one later with
// `t.from(descriptor)`. They label the portal's data (data/*.ts), which holds no English of its own.
import type { Descriptor } from "@elmeragroup/intl/core";
import { msg } from "@elmeragroup/intl/core";

import type { InvoiceStateTag } from "../data/invoice-run";
import type { ContractType, PriceArea } from "../data/market";
import type { MeteringPointStatus } from "../data/metering-points";
import type { PriceLevel } from "../data/power-data";

/** Where each price area is, for its filter and the invoice it bills. */
export const PRICE_AREA_NAMES = {
  NO1: msg("Eastern Norway"),
  NO2: msg("Southern Norway"),
  NO3: msg("Central Norway"),
  NO4: msg("Northern Norway"),
  NO5: msg("Western Norway"),
} as const satisfies Readonly<Record<PriceArea, Descriptor>>;

/** Each metering point status's label. */
export const STATUS_LABELS = {
  active: msg("Active"),
  onboarding: msg("Onboarding"),
  "moving-out": msg("Moving out"),
  disconnected: msg("Disconnected"),
} as const satisfies Readonly<Record<MeteringPointStatus, Descriptor>>;

/** Each contract type's label. */
export const CONTRACT_LABELS = {
  spot: msg("Spot"),
  fixed: msg("Fixed price"),
  variable: msg("Variable"),
} as const satisfies Readonly<Record<ContractType, Descriptor>>;

/**
 * Each invoice state's label. "Open" the state shares its English with "Open" the verb on the overview's button: the
 * context keeps the two apart, so each gets its own translation.
 */
export const INVOICE_STATE_LABELS = {
  Paid: msg("Paid"),
  Open: msg("Open", { context: "invoice state" }),
  Overdue: msg("Overdue"),
  Credited: msg("Credited"),
} as const satisfies Readonly<Record<InvoiceStateTag, Descriptor>>;

/** Each spot price level's badge. */
export const PRICE_LEVEL_LABELS = {
  low: msg("Low"),
  normal: msg("Normal"),
  high: msg("High"),
} as const satisfies Readonly<Record<PriceLevel, Descriptor>>;

/** The signed-in user's role, under their name in the account menu. */
export const SIGNED_IN_ROLE = msg("Customer operations");
