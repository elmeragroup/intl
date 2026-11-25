// The `cookie` header a Next request config hands the adapter, written from the request's cookie store.

/**
 * A cookie as Next's cookie store lists it (`cookies().getAll()`). The value can be missing: a proxy's
 * `Set-Cookie: flag=; Path=/`, merged into the store, lists `flag` without one.
 */
export type CookieEntry = { readonly name: string; readonly value?: string | undefined };

/**
 * The request's cookies as a `cookie` header, every listed cookie sent as Next serializes it: `name=` plus the
 * URI-encoded value (empty when the entry has none), pairs joined by `"; "`, exactly Next's own `stringifyCookie`, which
 * writes the request header when the store changes. `;` or `=` in a value cannot start another pair.
 *
 * The store is the one source: inside a server action `headers()` is the request as it arrived, so a cookie the
 * action set is only in `cookies()`, and Next rewrites the incoming header itself when the store first loads with a
 * proxy's cookies, so that header is no stable base to merge onto. Duplicate names therefore collapse as Next's
 * `cookies()` collapses them (the store keeps one value per name).
 *
 * Every cookie the store holds (`has(name)` is true) is sent, whether its value is empty, missing (a proxy's `flag=`)
 * or deleted (`ResponseCookies.delete` writes `""` with a past expiry): each as `name=`, as Next sends it.
 *
 * @param entries - The cookie store (`cookies().getAll()`).
 * @returns The header the adapter reads, `null` when the store is empty.
 */
export function cookieHeader(entries: ReadonlyArray<CookieEntry>): string | null {
  return entries.length === 0
    ? null
    : entries.map(({ name, value }) => `${name}=${encodeURIComponent(value ?? "")}`).join("; ");
}
