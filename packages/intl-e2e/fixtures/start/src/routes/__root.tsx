import type { ReactNode } from "react";
import { useEffect } from "react";

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { IntlProvider } from "@elmeragroup/intl/react";
import { createCatalogReload } from "@elmeragroup/intl/start";

import { getIntlConfig } from "../intl.functions";

export const Route = createRootRoute({
  loader: () => getIntlConfig(),
  shellComponent: RootDocument,
  component: Outlet,
});

// Dev: a saved intl/nb.po reruns the root loader, so an open tab shows the recompiled catalog.
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
        <Hydrated />
        <Scripts />
      </body>
    </html>
  );
}

// The specs wait for it before clicking: a click before hydration does nothing (a dev server hydrates late).
function Hydrated(): null {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return null;
}
