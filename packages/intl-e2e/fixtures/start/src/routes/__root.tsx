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

// The specs wait for it before clicking (a dev server hydrates late). It marks the root's hydration only: the route
// below it is its own boundary inside the root's Suspense and may hydrate later. On a click into it React attempts to
// hydrate it synchronously, which a boundary that suspends can block, or a mismatch can defeat by rendering it anew on
// the client. The router loads the route's code before hydrating, so it does not suspend on a chunk; a control there
// that can still suspend needs a readiness check of its own.
function Hydrated(): null {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return null;
}
