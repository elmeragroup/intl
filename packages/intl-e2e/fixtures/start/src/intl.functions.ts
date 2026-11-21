import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import type { Catalog } from "@elmeragroup/intl/core";
import { loadIntlConfig } from "@elmeragroup/intl/start";

import { formats } from "./intl/formats";

// The root loader's config, with the request locale's catalog.
export const getIntlConfig = createServerFn({ method: "GET" }).handler(() =>
  loadIntlConfig(
    {
      resolveLocale: (request) =>
        /(?:^|;\s*)locale=en(?:;|$)/u.test(request.headers.get("cookie") ?? "") ? "en" : "nb",
      resolveTimeZone: () => "Europe/Oslo",
      formats,
      loadCatalog: async (locale): Promise<Catalog> =>
        locale === "nb"
          ? (await import("./intl/nb.po")).default
          : (await import("./intl/nb.po?source")).default,
    },
    getRequest()
  )
);

// A plain server function called from the browser.
export const ping = createServerFn({ method: "POST" })
  .validator((name: string) => name)
  .handler(({ data }) => `pong ${data}`);
