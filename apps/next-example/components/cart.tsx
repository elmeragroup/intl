"use client";
import { useState } from "react";

import { T, useFormat, useT } from "@elmeragroup/intl/react";

import { ITEM_PRICE, ORDER, ORDER_STATUS } from "../intl/messages";
import { useHydrated } from "./use-hydrated";

/** A client component: translates and formats in the browser, and again on every state change. */
export function Cart() {
  const t = useT();
  const format = useFormat();
  const hydrated = useHydrated();
  const [count, setCount] = useState(0);

  return (
    <section aria-labelledby="cart-heading">
      <h2 id="cart-heading">
        <T>Your cart</T>
      </h2>
      <p id="cart-count">
        {t(
          "{count, plural, =0 {Your cart is empty} one {# item in your cart} other {# items in your cart}}",
          { count }
        )}
      </p>
      <p id="cart-total">{t("Total: {total, number, price}", { total: count * ITEM_PRICE })}</p>
      {/* One message, so a translator orders the parts and their punctuation; the status and date arrive translated and
          formatted. */}
      <p id="cart-order">
        {t("Order {id}: {status}, {placedAt}", {
          id: ORDER.id,
          status: t.from(ORDER_STATUS[ORDER.status]),
          placedAt: format.dateTime(ORDER.placedAt, "short"),
        })}
      </p>
      <button type="button" disabled={!hydrated} onClick={() => setCount((current) => current + 1)}>
        <T>Add an item</T>
      </button>
    </section>
  );
}
