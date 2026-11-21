import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vitest";

import type { CreateIntlOptions } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";

import { compiled, english } from "./catalogs";

const SOURCE = "Hello, {name}";
const CATALOGS = { nb: compiled("nb", { [SOURCE]: "Hei, {name}" }), en: english(SOURCE) } as const;

// What a server knows of the request the options resolve from: its locale (a cookie, in an app).
class RequestLocale extends Context.Service<RequestLocale, keyof typeof CATALOGS>()("RequestLocale") {}

class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()("CatalogUnavailable", {
  locale: Schema.String,
}) {}

// Opens once `parties` fibers have arrived, so each waits inside its request until every other request is inside its
// own: their translators are alive at the same time.
const makeBarrier = Effect.fn("makeBarrier")(function* (parties: number) {
  const arrived = yield* Ref.make(0);
  const open = yield* Deferred.make<void>();
  const arrive = Effect.gen(function* () {
    const count = yield* Ref.updateAndGet(arrived, (n) => n + 1);

    if (count === parties) {
      yield* Deferred.succeed(open, undefined);
    }

    yield* Deferred.await(open);
  });

  return { arrive };
});

// One runtime, as a server holds one for every request.
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

// Unit under test: `CurrentIntl.provide`, the per-request form, run as a server runs requests: the handler is composed
// once (as HttpRouter.middleware composes it) and each request runs it on the same ManagedRuntime. Oracle: the
// translation each request's catalog states (nb "Hei, Ada", en the source "Hello, Ada"), and the typed failure the
// options effect states. A translator kept from one run to the next (memoized options) fails the first case.
describe("CurrentIntl.provide", () => {
  it("gives two overlapping requests in two locales their own translator", async () => {
    const barrier = await runtime.runPromise(makeBarrier(2));
    const intlOptions = Effect.gen(function* () {
      const locale = yield* RequestLocale;

      return { locale, catalog: CATALOGS[locale], timeZone: "UTC" };
    });
    const handler = Effect.gen(function* () {
      const { t } = yield* CurrentIntl;
      yield* barrier.arrive;

      return t("Hello, {name}", { name: "Ada" });
    }).pipe(CurrentIntl.provide(intlOptions));
    const request = (locale: keyof typeof CATALOGS) =>
      runtime.runPromise(handler.pipe(Effect.provideService(RequestLocale, locale)));

    expect(await Promise.all([request("nb"), request("en")])).toEqual(["Hei, Ada", "Hello, Ada"]);
  });

  it("fails with the options effect's error, without running the handler", async () => {
    const ran = await runtime.runPromise(Ref.make(false));
    const options: Effect.Effect<CreateIntlOptions, CatalogUnavailable> = Effect.fail(
      new CatalogUnavailable({ locale: "nb" })
    );
    const handler = Effect.gen(function* () {
      const { t } = yield* CurrentIntl;
      yield* Ref.set(ran, true);

      return t("Hello, {name}", { name: "Ada" });
    }).pipe(CurrentIntl.provide(options));

    expect(await runtime.runPromise(Effect.exit(handler))).toEqual(
      Exit.fail(new CatalogUnavailable({ locale: "nb" }))
    );
    expect(await runtime.runPromise(Ref.get(ran))).toBe(false);
  });
});
