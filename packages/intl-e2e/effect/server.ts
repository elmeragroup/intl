// A consumer of the packed `@elmeragroup/intl/effect`, run by scripts/e2e.ts in a directory of its own: the README's
// middleware and composition, answering two overlapping Web requests through `HttpRouter.toWebHandler`, on core
// `effect/http` with no server and no platform package: one with no cookie whose Accept-Language asks for Nynorsk,
// which `negotiateLocale` (`/core`, loaded at runtime) maps to `nb`, and one whose cookie `en` wins over its
// Accept-Language `nb`. It prints each response's text as JSON; the e2e script holds them to the catalogs.
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import type { Catalog } from "@elmeragroup/intl/core";
import { negotiateLocale } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";

const LOCALES = ["en", "nb"] as const;

// App-owned: compiled catalogs, loaded the app's way (here, a module e2e.ts writes beside this file).
const loadCatalog = (locale: "en" | "nb"): Effect.Effect<Catalog> =>
  Effect.promise(() => import("./catalogs.js")).pipe(Effect.map((catalogs) => catalogs[locale]));

const intlOptions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // App policy: a stored choice, else the best of Accept-Language (Norwegian and Nynorsk as Bokmål), else English.
  const stored = LOCALES.find((locale) => locale === request.cookies.locale);
  const locale =
    stored ??
    negotiateLocale(request.headers["accept-language"], LOCALES, { aliases: { no: "nb", nn: "nb" } }) ??
    "en";

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

// Never run, only type-checked: `t` is typed from its literal through the packed declarations and their
// dependencies, so a packed runtime that lost @schummar/icu-type-parser fails here as an unused directive.
const _typedFromLiteral = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;

  // @ts-expect-error a plain {x} takes text
  return t("Hello, {name}", { name: 1 });
});

// No request log: stdout carries only the answers.
const { handler, dispose } = HttpRouter.toWebHandler(
  HttpRouter.add("GET", "/", greet).pipe(Layer.provide(IntlMiddleware)),
  { disableLogger: true }
);

// One argument: the type-check against the built declarations fails if a requirement is left for the caller.
const answer = async (headers: Readonly<Record<string, string>>): Promise<string> =>
  (await handler(new Request("http://localhost/", { headers }))).text();

try {
  const answers = await Promise.all([
    answer({ "accept-language": "nn-NO, en;q=0.5" }),
    answer({ cookie: "locale=en", "accept-language": "nb" }),
  ]);
  console.log(JSON.stringify(answers));
} finally {
  await dispose();
}
