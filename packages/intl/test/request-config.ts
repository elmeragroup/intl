// The request config `@elmeragroup/intl/internal/request-config` and `internal/request-module` resolve to in these tests
// (vitest.config.ts), as withIntl's alias points the request module at an app's `intl/request.ts`: the server half of
// format.test.tsx's server/client check.
import type { IntlConfig, RequestConfig } from "@elmeragroup/intl/core";

import { APP_FORMATS } from "./app-formats";
import { english } from "./catalogs";

/** The config format.test.tsx's client half renders with: Norwegian, Oslo, the adopting app's formats. */
export const REQUEST_CONFIG: IntlConfig = {
  locale: "no",
  catalog: english(),
  timeZone: "Europe/Oslo",
  formats: APP_FORMATS,
};

const requestConfig: RequestConfig = () => Promise.resolve(REQUEST_CONFIG);

export default requestConfig;
