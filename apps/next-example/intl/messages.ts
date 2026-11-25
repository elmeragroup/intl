// Messages declared at module scope with msg(): extraction reads them here, and a component renders one later with
// `t.from(descriptor)`. The demo data beside them is fixed, so every render (and the tests) shows the same values.
import { msg } from "@elmeragroup/intl/core";

/** An order's lifecycle. */
export type OrderStatus = "placed" | "shipped" | "delivered";

/** Each status's label, translated where it renders. */
export const ORDER_STATUS = {
  placed: msg("Placed"),
  shipped: msg("Shipped"),
  delivered: msg("Delivered"),
} as const;

/** "Open" as the shop's opening state; the context tells it apart from the verb on a button. */
export const SHOP_OPEN = msg("Open", { context: "shop opening state" });

/** The example order the page shows. */
export const ORDER = {
  id: "A-1001",
  status: "shipped",
  total: 1234.5,
  // 00:30 on 5 March in Oslo, the configured zone: still 4 March in UTC and further west.
  placedAt: new Date("2026-03-04T23:30:00Z"),
  shippedAt: new Date("2026-03-06T08:00:00Z"),
  // Delivered between 08:00 and 16:00 on Monday 9 March in Oslo (UTC+1 until summer time on 29 March): 03:00 to 11:00
  // in New York, so a range in the host's zone would read differently.
  delivery: { from: new Date("2026-03-09T07:00:00Z"), until: new Date("2026-03-09T15:00:00Z") },
  pickupPoints: ["Oslo", "Bergen", "Trondheim"],
} as const satisfies {
  readonly id: string;
  readonly status: OrderStatus;
  readonly total: number;
  readonly placedAt: Date;
  readonly shippedAt: Date;
  readonly delivery: { readonly from: Date; readonly until: Date };
  readonly pickupPoints: ReadonlyArray<string>;
};

/**
 * The moment relative times are measured from. An app passes its clock's `now`; the example fixes it two hours after
 * shipping, so the server and the browser render the same phrase.
 */
export const NOW = new Date("2026-03-06T10:00:00Z");

/** The price of one item in the cart. */
export const ITEM_PRICE = 249;
