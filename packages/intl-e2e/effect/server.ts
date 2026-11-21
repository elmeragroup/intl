// A consumer of the packed `@elmeragroup/intl/effect`, run by scripts/e2e.ts in a directory of its own: the README's
// middleware and composition, answering two overlapping Web requests (cookies `nb` and `en`) through
// `HttpRouter.toWebHandler`, on core `effect/http` with no server and no platform package. It prints each response's
// text as JSON; the e2e script holds them to the catalogs.
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import type { Catalog } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";

// App-owned: compiled catalogs, loaded the app's way (here, a module e2e.ts writes beside this file).
const loadCatalog = (locale: "en" | "nb"): Effect.Effect<Catalog> =>
  Effect.promise(() => import("./catalogs.js")).pipe(Effect.map((catalogs) => catalogs[locale]));

const intlOptions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const locale = request.cookies.locale === "nb" ? "nb" : "en";

  return { locale, catalog: yield* loadCatalog(locale), timeZone: "Europe/Oslo" };
});

const IntlMiddleware = HttpRouter.middleware<{ provides: CurrentIntl }>()(
  (handler) => handler.pipe(CurrentIntl.provide(intlOptions)),
  { global: true }
);

const greet = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;

  return HttpServerResponse.text(t("Hello, {name}", { name: "Ada" }));
});

// No request log: stdout carries only the answers.
const { handler, dispose } = HttpRouter.toWebHandler(
  HttpRouter.add("GET", "/", greet).pipe(Layer.provide(IntlMiddleware)),
  { disableLogger: true }
);

// One argument: the type-check against the built declarations fails if a requirement is left for the caller.
const answer = async (locale: string): Promise<string> =>
  (await handler(new Request("http://localhost/", { headers: { cookie: `locale=${locale}` } }))).text();

try {
  console.log(JSON.stringify(await Promise.all([answer("nb"), answer("en")])));
} finally {
  await dispose();
}
