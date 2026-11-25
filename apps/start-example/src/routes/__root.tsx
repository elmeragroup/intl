import type { ReactNode } from "react";

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { IntlProvider } from "@elmeragroup/intl/react";
import { createCatalogReload } from "@elmeragroup/intl/start";

import { getIntlConfig } from "../intl/intl.functions";
import { LOCALIZED_CACHE_CONTROL } from "../intl/locale";

export const Route = createRootRoute({
  // The request's locale, catalog, zone and formats. A locale switch re-runs it, and the provider swaps in place.
  loader: () => getIntlConfig(),
  // The document's headers: every page renders in the request's locale.
  headers: () => ({ "Cache-Control": LOCALIZED_CACHE_CONTROL }),
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

// Dev only: saving src/intl/nb.po re-runs the loaders, so an open tab shows the recompiled catalog.
const CatalogReload = createCatalogReload(import.meta.hot);

function RootDocument({ children }: { readonly children: ReactNode }) {
  const intlConfig = Route.useLoaderData();

  return (
    <html lang={intlConfig.locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <IntlProvider
          locale={intlConfig.locale}
          catalog={intlConfig.catalog}
          timeZone={intlConfig.timeZone}
          formats={intlConfig.formats}>
          {children}
        </IntlProvider>
        <CatalogReload />
        <Scripts />
      </body>
    </html>
  );
}
