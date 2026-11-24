// An API route that answers in the request's language. A server route builds its translator from its own request,
// `createIntl(await loadIntlConfig(adapter, request))` in the handler itself: extraction traces a translator only to a
// factory call in the same file.
import { createFileRoute } from "@tanstack/react-router";

import { createIntl } from "@elmeragroup/intl/core";
import { loadIntlConfig } from "@elmeragroup/intl/start";

import { adapter } from "../../intl/adapter";
import { LOCALIZED_CACHE_CONTROL } from "../../intl/locale";

/** `GET /api/greeting`: a sentence in the request's locale (the stored choice, then Accept-Language), as plain text. */
export const Route = createFileRoute("/api/greeting")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const intl = createIntl(await loadIntlConfig(adapter, request));

        return new Response(intl.t("This test alert was translated by an API route."), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LOCALIZED_CACHE_CONTROL },
        });
      },
    },
  },
});
