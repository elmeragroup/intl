// An API route that answers in the request's language. The handler is an Effect program that reads the translator as
// a service; CurrentIntl.provide builds it from this request, through the app's adapter.
import { createFileRoute } from "@tanstack/react-router";
import * as Effect from "effect/Effect";

import { CurrentIntl } from "@elmeragroup/intl/effect";
import { loadIntlConfig } from "@elmeragroup/intl/start";

import { adapter } from "../../intl/adapter";
import { LOCALIZED_CACHE_CONTROL } from "../../intl/locale";

const greeting = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;

  return new Response(t("This text was translated by an API route."), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LOCALIZED_CACHE_CONTROL },
  });
});

/** `GET /api/greeting`: a sentence in the request's locale (the stored choice, then Accept-Language), as plain text. */
export const Route = createFileRoute("/api/greeting")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Effect.runPromise(
          greeting.pipe(CurrentIntl.provide(Effect.promise(() => loadIntlConfig(adapter, request))))
        ),
    },
  },
});
