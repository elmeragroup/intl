// Server-only: the per-request IntlInstance React Server Components read, from the request config the host's build
// plugin resolves.
import { cache } from "react";

// The package's own specifier, not `./request-config`: it stays an import in the build, so the host's bundler resolves
// it by export condition. Under `react-server` it reaches the app's request module through the alias the host's build
// plugin sets (Next: withIntl's `turbopack.resolveAlias`); client and SSR code get the stub, whose error names the
// cause. A relative import would be bundled in, and the stub would always win.
import requestConfig from "@elmeragroup/intl/internal/request-config";

import type { Format, IntlInstance, Translate } from "./intl";
import { createIntl } from "./intl";

/**
 * The current request's translator. Layouts and pages render in parallel, and actions and route handlers load no
 * layout, so each reader resolves it here; `React.cache` shares one instance within a render.
 *
 * @returns The request's `IntlInstance`.
 * @throws When the host has no request config (no `withIntl` in next.config): a setup defect, not a request failure.
 */
export const getIntl: () => Promise<IntlInstance> = /* @__PURE__ */ cache(async (): Promise<IntlInstance> =>
  createIntl(await requestConfig())
);

/**
 * The current request's `t`, for async server components (`const t = await getT()`).
 *
 * @returns The request's translate function.
 */
export async function getT(): Promise<Translate> {
  const intl = await getIntl();

  return intl.t;
}

/**
 * The current request's formatter, next-intl's `getFormatter()`, for async server components
 * (`const format = await getFormat()`).
 *
 * @returns The request's `format`.
 */
export async function getFormat(): Promise<Format> {
  const intl = await getIntl();

  return intl.format;
}
