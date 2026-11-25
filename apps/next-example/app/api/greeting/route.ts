// An API route that answers in the request's language. A route handler reads the translator as a server component does,
// `await getT()`: withIntl's alias hands it the request config (intl/request.ts), which reads this request's cookie and
// Accept-Language.
import { getT } from "@elmeragroup/intl/server";

import { LOCALIZED_CACHE_CONTROL } from "../../../intl/locale";

/**
 * `GET /api/greeting`: a sentence in the request's locale (the stored choice, then Accept-Language), as plain text.
 *
 * @returns The plain-text response, never cached: it varies by cookie and Accept-Language.
 */
export async function GET(): Promise<Response> {
  const t = await getT();

  return new Response(t("This test alert was translated by an API route."), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LOCALIZED_CACHE_CONTROL },
  });
}
