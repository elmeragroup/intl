// Server-only: the per-request IntlInstance React Server Components read, resolved lazily by the framework adapter.
import { cache } from "react";

import type { Format, IntlInstance, Translate } from "./intl";

// The one process-wide seam a framework adapter fills at module load (Next renders layout and page in parallel, so
// each reads the same cached per-request value). Not request state: the resolver reads the request itself.
let resolveRequestIntl: (() => Promise<IntlInstance>) | undefined;

/**
 * Register how a request's `IntlInstance` is built. Call once at server module load (a framework adapter such as
 * `@elmeragroup/intl/next/server` does it for you).
 *
 * @param resolver - Builds the current request's translator; called at most once per request.
 */
export function configureRequestIntl(resolver: () => Promise<IntlInstance>): void {
  resolveRequestIntl = resolver;
}

/**
 * The current request's translator, cached per request with `React.cache`.
 *
 * @returns The request's `IntlInstance`.
 * @throws When `configureRequestIntl` was never called: a setup defect, not a request failure.
 */
export const getIntl: () => Promise<IntlInstance> = cache(async (): Promise<IntlInstance> => {
  if (!resolveRequestIntl) {
    throw new Error(
      "configureRequestIntl was not called; configure the request IntlInstance in a server module first"
    );
  }

  return resolveRequestIntl();
});

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
