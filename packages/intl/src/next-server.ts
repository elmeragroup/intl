// Next.js server adapter: resolve each request's IntlInstance lazily from its headers (cookies included).
import { headers } from "next/headers";

import type { ServerAdapter } from "./adapter";
import { resolveIntlConfig } from "./adapter";
import { createIntl } from "./intl";
import { configureRequestIntl } from "./server";

export type { RequestLike, ServerAdapter } from "./adapter";

/**
 * Wire the app's server adapter into `getIntl`/`getT` and the server `<T>`/`useT`. Call it at module load in a
 * server-only module that the root layout and every page import, so it runs before any render reads the request.
 *
 * @param adapter - Locale resolution, catalog loading, time zone and formats.
 */
export function configureNextIntl(adapter: ServerAdapter): void {
  configureRequestIntl(async () =>
    createIntl(await resolveIntlConfig(adapter, { headers: await headers() }))
  );
}
