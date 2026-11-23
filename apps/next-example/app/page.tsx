import { Plural, Select, T, Val } from "@elmeragroup/intl/react";
import { getFormat, getT } from "@elmeragroup/intl/server";

import { ApiDemo } from "../components/api-demo";
import { Cart } from "../components/cart";
import { LocaleSwitcher } from "../components/locale-switcher";
import "../intl/configure";
import { NOW, ORDER, ORDER_STATUS, SHOP_OPEN } from "../intl/messages";

/** The example page: server-rendered messages and formats, then the client and API demos. */
export default async function Home() {
  const t = await getT();
  const format = await getFormat();

  return (
    <main>
      <LocaleSwitcher />

      <section aria-labelledby="server-heading">
        <h1 id="server-heading">
          <T>Welcome to the example shop</T>
        </h1>
        <p id="server-note">{t("This page was rendered on the server.")}</p>
        <p id="server-messages">
          <T>
            Hello <Val name="Kari" />, you have{" "}
            <Plural count={3} _0="no new messages" one="# new message" other="# new messages" />.
          </T>
        </p>
        <p id="server-delivery">
          <T>
            Delivered to your <Select place="office" _home="home" _office="office" other="pickup point" />.
          </T>
        </p>
        <p id="server-terms">
          <T>
            Read our <a href="#terms">terms of sale</a> before you order.
          </T>
        </p>
      </section>

      <section aria-labelledby="order-heading">
        <h2 id="order-heading">{t("Order {id}", { id: ORDER.id })}</h2>
        <dl>
          <dt>{t("Order status")}</dt>
          <dd id="order-status">{t.from(ORDER_STATUS[ORDER.status])}</dd>
          <dt>{t("Shop")}</dt>
          <dd id="shop-state">{t.from(SHOP_OPEN)}</dd>
          <dt>{t("Order date")}</dt>
          <dd id="order-placed">{t("Placed on {placedAt, date, short}", { placedAt: ORDER.placedAt })}</dd>
          <dt>{t("Total")}</dt>
          <dd id="order-total">{format.number(ORDER.total, "price")}</dd>
          <dt>{t("Shipping")}</dt>
          <dd id="order-shipped">{format.relativeTime(ORDER.shippedAt, NOW)}</dd>
          <dt>{t("Delivery window")}</dt>
          {/* A date range formats only here, in a server component: its spacing differs between ICU releases (in
              English, Node 24's ICU 78.2 uses U+2009 and U+202F where Node 26 and Chromium put plain spaces), so a
              client component formatting one could hydrate to text that differs from the server's. */}
          <dd id="order-delivery">
            {format.dateTimeRange(ORDER.delivery.from, ORDER.delivery.until, {
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </dd>
          <dt>{t("Pickup points")}</dt>
          <dd id="order-pickup">{format.list(ORDER.pickupPoints, { type: "conjunction" })}</dd>
          <dt>
            <T>Terms of sale</T>
          </dt>
          {/* "Open" the verb; SHOP_OPEN above is "Open" the state. One English word, two translations: the context
              keys each apart. */}
          <dd>
            <a id="terms-open" href="#terms">
              <T context="verb">Open</T>
            </a>
          </dd>
        </dl>
      </section>

      <Cart />
      <ApiDemo />

      <section id="terms" aria-labelledby="terms-heading">
        <h2 id="terms-heading">
          <T>Terms of sale</T>
        </h2>
        <p id="terms-text">
          <T>Orders ship within two working days, and you can return an item within 30 days.</T>
        </p>
      </section>
    </main>
  );
}
