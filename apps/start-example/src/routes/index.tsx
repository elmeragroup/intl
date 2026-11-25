import { createFileRoute } from "@tanstack/react-router";

import { Plural, Select, T, useFormat, useIntl, Val } from "@elmeragroup/intl/react";

import { ApiDemo } from "../components/api-demo";
import { Cart } from "../components/cart";
import { LocaleSwitcher } from "../components/locale-switcher";
import { NOW, ORDER, ORDER_STATUS, SHOP_OPEN } from "../intl/messages";
import { getHomeLoaderData } from "../server/shop.functions";

export const Route = createFileRoute("/")({
  loader: () => getHomeLoaderData(),
  component: Home,
});

// Rendered on the server for the first response, then hydrated: the same messages and formats on both sides.
function Home() {
  const { notice, deliveryWindow } = Route.useLoaderData();
  const intl = useIntl();
  const format = useFormat();

  return (
    <main>
      <LocaleSwitcher />

      <section aria-labelledby="server-heading">
        <h1 id="server-heading">
          <T>Welcome to the example shop</T>
        </h1>
        <p id="loader-notice">{notice}</p>
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
        <h2 id="order-heading">{intl.t("Order {id}", { id: ORDER.id })}</h2>
        <dl>
          <dt>{intl.t("Order status")}</dt>
          <dd id="order-status">{intl.t.from(ORDER_STATUS[ORDER.status])}</dd>
          <dt>{intl.t("Shop")}</dt>
          <dd id="shop-state">{intl.t.from(SHOP_OPEN)}</dd>
          <dt>{intl.t("Order date")}</dt>
          <dd id="order-placed">
            {intl.t("Placed on {placedAt, date, short}", { placedAt: ORDER.placedAt })}
          </dd>
          <dt>{intl.t("Total")}</dt>
          <dd id="order-total">{format.number(ORDER.total, "price")}</dd>
          <dt>{intl.t("Shipping")}</dt>
          <dd id="order-shipped">{format.relativeTime(ORDER.shippedAt, NOW)}</dd>
          <dt>{intl.t("Delivery window")}</dt>
          {/* Formatted in the loader: see getHomeLoaderData. */}
          <dd id="order-delivery">{deliveryWindow}</dd>
          <dt>{intl.t("Pickup points")}</dt>
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
