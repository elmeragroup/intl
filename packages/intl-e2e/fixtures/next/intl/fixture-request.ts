// The fixture's request module, at a path of its own that next.config passes as withIntl's `request` (the default,
// intl/request.ts, is the example app's). It imports the package and declares no messages. The adapter reads the locale
// from the request's `cookie` header, not `cookies()`, so the server-action switch spec sees the cookie
// createRequestConfig writes into that header. REQUEST_SENTINEL is a string only this module's code holds, so a client
// chunk that carries it carries the request module (the server-from-client spec). Its onError records each report's key
// for the request (the reports page shows them) and logs it as the runtime's default would, so a corpus page that
// reports still fails the specs that collect console errors.
import type { Catalog } from "@elmeragroup/intl/core";
import { createRequestConfig } from "@elmeragroup/intl/next/server";

import { formats } from "./formats";
import { requestReports } from "./request-reports";

const REQUEST_SENTINEL = "FORESPORSELVAKT-5R8";

export default createRequestConfig(
  {
    resolveLocale: (request) =>
      /(?:^|;\s*)locale=en(?:;|$)/u.test(request.headers.get("cookie") ?? "") ? "en" : "no",
    resolveTimeZone: () => "Europe/Oslo",
    formats,
    loadCatalog: async (locale): Promise<Catalog> => {
      switch (locale) {
        case "no":
          return (await import("./no.po")).default;
        case "en":
          return (await import("./no.po?source")).default;
        default:
          throw new Error(`${REQUEST_SENTINEL}: the fixture has no catalog for ${locale}`);
      }
    },
  },
  {
    onError: (error, key) => {
      requestReports().push(key);
      console.error("@elmeragroup/intl:", JSON.stringify(key), error);
    },
  }
);
