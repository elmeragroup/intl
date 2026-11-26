// Next.js server adapter: the app's request config, built from the request's headers with its cookies as the request
// currently holds them.
import { cookies, headers } from "next/headers";

import type { RequestConfig, RequestLike, ServerAdapter } from "./adapter";
import { resolveIntlConfig } from "./adapter";
import { cookieHeader } from "./request-cookies";

export type { RequestConfig, RequestLike, ServerAdapter } from "./adapter";

/** `createRequestConfig`'s options: what the server translator does beside the adapter's config. */
export type RequestConfigOptions = {
  /**
   * `createIntl`'s `onError` for every server translator the request config builds (`getIntl`, the server `<T>`):
   * with none, each distinct problem is written once to `console.error`, on the server's stderr.
   */
  readonly onError?: (error: Error, key: string) => void;
};

/**
 * The app's request config: the default export of `intl/request.ts`, which `withIntl` resolves `getIntl`, `getT`,
 * `getFormat` and the server `<T>`/`useT` to. No page, layout, action or route imports it. Its `onError` option is the
 * server translator's handler (a server component cannot pass one); the config it resolves carries it, and the
 * translator never exposes it, so a layout passes its `IntlConfig` fields to the client provider.
 *
 * The adapter sees the request's headers, except `cookie`, which is written from `cookies()`: inside a server action,
 * `headers()` is the request as it arrived, so a locale cookie the action just set is only in `cookies()`, and the
 * page Next re-renders in the action's response would otherwise resolve the old locale.
 *
 * `cookies()` is Next's own store, which Next builds from the request's headers on the first `cookies()` read and then
 * caches apart from a route handler's `NextRequest`. A rewrite of the incoming request's cookies
 * (`request.cookies.set(...)`) made before anything in the request has read `cookies()` is seen by `getIntl()`; a
 * rewrite made after Next has initialized its store (a `cookies()` read, `getIntl()` included, came first) is not, and
 * `getIntl()` resolves the old locale. For that case, a handler can build its config from the request it rewrote,
 * `createIntl(await resolveIntlConfig(adapter, request))` (both from `@elmeragroup/intl/core`), but only with an adapter
 * that reads the passed request's `cookie` header (`request.headers.get("cookie")`); an adapter that reads `cookies()`
 * itself still sees Next's store, and the old locale.
 *
 * @param adapter - Locale resolution, catalog loading, time zone and formats.
 * @param options - The server's `onError`.
 * @returns The request config, read per call.
 */
export function createRequestConfig(adapter: ServerAdapter, options?: RequestConfigOptions): RequestConfig {
  const onError = options?.onError;

  return async () => {
    const [incoming, jar] = await Promise.all([headers(), cookies()]);
    const request: RequestLike = {
      headers: {
        // Written only when the adapter reads it.
        get: (name) => (name.toLowerCase() === "cookie" ? cookieHeader(jar.getAll()) : incoming.get(name)),
      },
    };

    const config = await resolveIntlConfig(adapter, request);

    return onError === undefined ? config : { ...config, onError };
  };
}
