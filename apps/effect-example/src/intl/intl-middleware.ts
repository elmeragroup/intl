// The translator per request: the implementation of the API's one middleware (declared in api.ts). It picks the
// request's locale, provides `CurrentIntl` for it with `CurrentIntl.provide`, so a handler reads
// `const { t, format } = yield* CurrentIntl`, and says on the response which language it is in and what it varied by.
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import { CurrentIntl } from "@elmeragroup/intl/effect";

import { IntlMiddleware, InvalidRequest, LOCALE_PARAMETER } from "../api.ts";
import { TIME_ZONE } from "../data/invoices.ts";
import { varyBy } from "../http-vary.ts";
import { Catalogs } from "./catalogs.ts";
import { formats } from "./formats.ts";
import type { Locale } from "./locale.ts";
import { chooseLocale } from "./locale.ts";

// The response, in the request's language, saying so: the language it is in (RFC 9110 §8.5), that it varies by
// Accept-Language, added to whatever it already varies by (§12.5.5; the `lang` parameter is in the URL, which a cache
// already keys on), and that no shared cache may store it.
function localized(response: HttpServerResponse.HttpServerResponse, locale: Locale) {
  return HttpServerResponse.setHeaders(response, {
    "content-language": locale,
    vary: varyBy(response.headers.vary, "Accept-Language"),
    "cache-control": "private, no-store",
  });
}

// The parts of a request its endpoint decodes. A `Body` or `ResponseHeaders` schema error is the answer failing to
// encode: the server's bug, which keeps effect's 500.
const REQUEST_PARTS: ReadonlySet<string> = new Set(["Params", "Headers", "Query", "Payload"]);

// The `InvalidRequest` for the request's language.
const invalidRequest = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;

  return yield* new InvalidRequest({
    message: t("This request is missing a parameter, or has one that is not valid."),
  });
});

/**
 * `IntlMiddleware` over the catalogs loaded at start. Per request with `CurrentIntl.provide`, never as a layer: a
 * layer is built once and would hand every request the first one's locale.
 */
export const layer: Layer.Layer<IntlMiddleware, never, Catalogs> = Layer.effect(
  IntlMiddleware,
  Effect.gen(function* () {
    const catalogs = yield* Catalogs;

    // Runs once per request, when the endpoint's effect runs: the locale, its catalog, the market's zone and the
    // formats, and the response's headers for that locale, set on whatever the endpoint answers, an error included.
    const intlOptions = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = yield* HttpServerRequest.ParsedSearchParams;
      // The `lang` parameter counts only when the query has it once; twice is no choice.
      const override = query[LOCALE_PARAMETER];
      const locale = chooseLocale(
        Array.isArray(override) ? undefined : override,
        request.headers["accept-language"]
      );

      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(localized(response, locale))
      );

      return { locale, catalog: catalogs[locale], timeZone: TIME_ZONE, formats };
    });

    // The endpoint's effect decodes the request, then runs its handler: a request that does not decode fails inside
    // it, where `CurrentIntl` is already provided, so its 400 is in the request's language too.
    return (httpEffect) =>
      httpEffect.pipe(
        // effect answers a request that does not decode with an empty 400; this one says why, in the language.
        Effect.catchIf(
          (error) => HttpApiError.HttpApiSchemaError.is(error) && REQUEST_PARTS.has(error.kind),
          () => invalidRequest
        ),
        CurrentIntl.provide(intlOptions)
      );
  })
);
