import type { ReactNode } from "react";

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { ColorSchemeScript, documentAttributes, ThemeProvider } from "@elmeragroup/fuse/theme";
import type { ColorSchemeOptions, ThemeInput } from "@elmeragroup/fuse/theme";
import { IntlProvider } from "@elmeragroup/intl/react";
import { createCatalogReload } from "@elmeragroup/intl/start";

import { AppShell } from "../components/app-shell";
import { getShellConfig } from "../intl/intl.functions";
import { LOCALIZED_CACHE_CONTROL } from "../intl/locale";

import appCss from "../styles.css?url";

// Fuse's neutral theme at dense density, the look of an internal tool, as Fuse's docs preview the app-shell block.
const THEME = { identity: "neutral", brand: "fkas", segment: "private" } as const satisfies ThemeInput;

// The visitor's light, dark or system appearance, kept in the browser under a key of the app's own.
const COLOR_SCHEME = {
  storageKey: "start-example-color-scheme",
  defaultColorScheme: "system",
  enableSystem: true,
} as const satisfies ColorSchemeOptions;

export const Route = createRootRoute({
  // The request's locale, catalog, zone and formats, and the sidebar's first state. A locale switch re-runs it through
  // `router.invalidate`, and the provider swaps in place.
  loader: () => getShellConfig(),
  // The document's headers: every page renders in the request's locale. The loaders' server functions set the same
  // policy while the document renders, and a header a loader sets wins over these.
  headers: () => ({ "Cache-Control": LOCALIZED_CACHE_CONTROL }),
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

// Dev only: saving a catalog (src/intl/*.po) re-runs the loaders, so an open tab shows the recompiled catalog.
const CatalogReload = createCatalogReload(import.meta.hot);

// The document, and the shell (sidebar, header, command menu) around every page, so the shell keeps its state while
// the pages change. A failed loader renders in the shell's page slot (src/components/load-error.tsx); the shell keeps
// the config it last loaded, so the error is in the language the page shows.
function RootDocument({ children }: { readonly children: ReactNode }) {
  const { intl, sidebarOpen } = Route.useLoaderData();

  return (
    // The color scheme script sets the scheme's class on <html> before React hydrates it.
    <html
      lang={intl.locale}
      {...documentAttributes({ theme: THEME, density: "dense" })}
      suppressHydrationWarning>
      <head>
        <ColorSchemeScript {...COLOR_SCHEME} />
        <HeadContent />
      </head>
      <body className="m-0 min-w-80 bg-background font-sans text-foreground antialiased">
        <ThemeProvider theme={THEME} {...COLOR_SCHEME} injectColorSchemeScript={false}>
          <IntlProvider
            locale={intl.locale}
            catalog={intl.catalog}
            timeZone={intl.timeZone}
            formats={intl.formats}>
            <AppShell sidebarOpen={sidebarOpen}>{children}</AppShell>
          </IntlProvider>
        </ThemeProvider>
        <CatalogReload />
        <Scripts />
      </body>
    </html>
  );
}
