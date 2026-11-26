// The framework adapter contract: how a request picks its locale and catalog, and how a host reads the result.
import type { Catalog, Formats, IntlConfig } from "./intl";

/** The part of a request locale resolution reads: a `Request`, or the request Next's `createRequestConfig` builds. */
export type RequestLike = {
  readonly headers: { get(name: string): string | null };
};

/** Server half of an app's adapter: how a request picks its locale and catalog. */
export type ServerAdapter = {
  /** The request's locale, e.g. from a cookie. Returns a locale the app has a catalog for. */
  resolveLocale(request: RequestLike): string | Promise<string>;
  /** The locale's compiled catalog: a `*.po` import (`./intl/no.po`, or `./intl/no.po?source` for `en`). */
  loadCatalog(locale: string): Promise<Catalog>;
  /** The request's IANA zone, which every date and time formats in (per request: one process may serve brands in several zones). */
  resolveTimeZone(request: RequestLike): string | Promise<string>;
  /** Named styles messages refer to (`{d, date, short}`), the same for every request, like next-intl's `formats`. */
  readonly formats?: Formats;
};

/** How a host reads the current request's `IntlConfig`, per call (Next: `createRequestConfig(adapter)`). */
export type RequestConfig = () => Promise<IntlConfig>;

/**
 * Resolve a request's `IntlConfig` through the app's adapter: the value both the server translator and the client
 * provider are built from.
 *
 * @param adapter - The app's server adapter.
 * @param request - The incoming request, or its headers.
 * @returns Locale, catalog, time zone and formats for the request.
 */
export async function resolveIntlConfig(adapter: ServerAdapter, request: RequestLike): Promise<IntlConfig> {
  const [locale, timeZone] = await Promise.all([
    adapter.resolveLocale(request),
    adapter.resolveTimeZone(request),
  ]);
  const catalog = await adapter.loadCatalog(locale);

  return { locale, catalog, timeZone, formats: adapter.formats };
}
