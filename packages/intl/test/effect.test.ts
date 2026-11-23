import * as Cause from "effect/Cause";
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

// The app's options effect: the request's locale and its catalog.
const requestOptions = Effect.gen(function* () {
  const locale = yield* RequestLocale;

  return { locale, catalog: CATALOGS[locale], timeZone: "UTC" };
});

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
    // Both requests have their translators before either reads one.
    const handler = Effect.gen(function* () {
      yield* barrier.arrive;
      const { t } = yield* CurrentIntl;

      return t("Hello, {name}", { name: "Ada" });
    }).pipe(CurrentIntl.provide(requestOptions));
    const request = (locale: keyof typeof CATALOGS) =>
      runtime.runPromise(handler.pipe(Effect.provideService(RequestLocale, locale)));

    expect(await Promise.all([request("nb"), request("en")])).toEqual(["Hei, Ada", "Hello, Ada"]);
  });

  // A layer would be built once by the outer provide and reused by the inner one (Effect.provide reuses a layer an
  // enclosing provide built), so the inner request would get the outer translator.
  it("gives a run nested in another its own translator from the same provider", async () => {
    const provideIntl = CurrentIntl.provide(requestOptions);
    const greet = Effect.gen(function* () {
      const { t } = yield* CurrentIntl;

      return t("Hello, {name}", { name: "Ada" });
    });
    const nested = Effect.gen(function* () {
      const outer = yield* greet;
      const inner = yield* greet.pipe(provideIntl, Effect.provideService(RequestLocale, "en"));

      return [outer, inner];
    }).pipe(provideIntl, Effect.provideService(RequestLocale, "nb"));

    expect(await runtime.runPromise(nested)).toEqual(["Hei, Ada", "Hello, Ada"]);
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

// Unit under test: `CurrentIntl.layer`, the fixed translator. Oracle: the translation the nb catalog states, and
// createIntl's own contract that a catalog of another catalog version is a defect, which the layer defers to the
// moment it is built.
describe("CurrentIntl.layer", () => {
  const greet = Effect.gen(function* () {
    const { t } = yield* CurrentIntl;

    return t("Hello, {name}", { name: "Ada" });
  });

  it("serves the translator its options build", async () => {
    const layer = CurrentIntl.layer({ locale: "nb", catalog: CATALOGS.nb, timeZone: "UTC" });

    expect(await runtime.runPromise(greet.pipe(Effect.provide(layer)))).toBe("Hei, Ada");
  });

  it("builds the translator when the layer is built, not when it is made", async () => {
    const catalog = { ...CATALOGS.nb, v: 999 };
    const layer = CurrentIntl.layer({ locale: "nb", catalog, timeZone: "UTC" });
    const exit = await runtime.runPromise(Effect.exit(greet.pipe(Effect.provide(layer))));
    const defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined;

    expect(defect).toBeInstanceOf(Error);
    expect(defect instanceof Error ? defect.message : undefined).toContain("catalog version 999");
  });
});
