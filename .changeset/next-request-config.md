---
"@elmeragroup/intl": minor
"@elmeragroup/intl-tools": minor
---

Next.js apps no longer import setup code in every page, layout and server action. `withIntl` now adds a Turbopack alias from the runtime's request config to the app's request module, `intl/request.ts` (or the new `request` option), whose default export is `createRequestConfig(adapter)` from `@elmeragroup/intl/next/server`; route handlers and server actions read the request's locale with no import. Drop `"sideEffects": true` and the `intl/configure` imports.

- Removed: `configureRequestIntl` (`/server`) and `configureNextIntl` (`/next/server`).
- Added: `createRequestConfig` (`/next/server`), the `RequestConfig` type (`/core`, `/next/server`), and `withIntl`'s `request` option and alias. Only the runtime's `react-server` request config imports the aliased specifier, so Client Component code (SSR and browser) gets the runtime's stub, which names the cause, and never the app's adapter. `withIntl` fails when a `turbopack.resolveAlias` key, exact or a wildcard whose pattern matches, already maps the runtime's request module: anything but an exact key to withIntl's own target, or any key when withIntl aliases none.
- Fixed (#20): inside a server action, the adapter now sees the locale cookie the action set, so the page Next re-renders in the action's response is in the new locale. The adapter's `cookie` header is written from `cookies()`.
