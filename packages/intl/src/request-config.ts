// The request config stub: what `@elmeragroup/intl/internal/request-config` resolves to outside the react-server
// condition (client and SSR code), and what `@elmeragroup/intl/internal/request-module` resolves to without a host
// alias. `getIntl` reads the current request's config from `internal/request-config`; under `react-server` it
// re-exports `internal/request-module` (request-config-server.ts), which a host's build plugin aliases to the app's
// request module (Next: `withIntl` points it at `./intl/request.ts`), so no page, layout, action or route has to import
// setup code first, and no client chunk can hold the app's adapter.
import type { RequestConfig } from "./adapter";

const MISSING =
  "@elmeragroup/intl/server read the request config, but the app's request module was not aliased in. If this runs " +
  "in a Client Component (or a module one imports), that code imported @elmeragroup/intl/server, which only server " +
  "code may use (Server Components, server actions and route handlers); in the Client Component, read the " +
  "provider's config with useT and useFormat from @elmeragroup/intl/react instead. In server code on Next.js " +
  "(Turbopack), either next.config does not wrap its config in withIntl from @elmeragroup/intl-tools/next, or the " +
  "request module does not resolve: " +
  "create intl/request.ts with `export default createRequestConfig(adapter)` (from @elmeragroup/intl/next/server), " +
  "or point withIntl's `request` option at the module you have. Turbopack falls back to this stub, without an " +
  "error, when the alias target does not resolve, and when the request module lies outside Turbopack's root. " +
  "withIntl looks for intl/request.ts when next.config loads, so restart `next dev` after creating it. On Node " +
  "server paths, a next.config whose serverExternalPackages lists @elmeragroup/intl, or a pattern that matches it, " +
  "loads the runtime unbundled, past the alias: remove it from that list (an Edge route still bundles the runtime " +
  "and keeps the alias). In server code without Next.js, no build plugin supplies the request config: on TanStack " +
  "Start, build the provider's config in a server function with loadIntlConfig from @elmeragroup/intl/start; " +
  "elsewhere, build it with resolveIntlConfig and createIntl from @elmeragroup/intl/core.";

/**
 * The request config without a host alias: rejects, naming the setup it is missing. It rejects when called, never
 * when imported, so `/server` and the server `/react` still load (and list their exports) in a host without one.
 *
 * @returns Never resolves; rejects with the setup the host is missing.
 */
const requestConfig: RequestConfig = () => Promise.reject(new Error(MISSING));

export default requestConfig;
