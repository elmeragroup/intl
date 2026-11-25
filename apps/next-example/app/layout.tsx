import type { ReactNode } from "react";

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { ColorSchemeScript, documentAttributes, ThemeProvider } from "@elmeragroup/fuse/theme";
import type { ColorSchemeOptions, ThemeInput } from "@elmeragroup/fuse/theme";
import { IntlProvider } from "@elmeragroup/intl/react";
import { getIntl, getT } from "@elmeragroup/intl/server";

import { SIDEBAR_COOKIE } from "../components/app-config";
import { AppShell } from "../components/app-shell";

import "./globals.css";

// Fuse's neutral theme at dense density, the look of an internal tool, as Fuse's docs preview the app-shell block.
const THEME = { identity: "neutral", brand: "fkas", segment: "private" } as const satisfies ThemeInput;

// The visitor's light, dark or system appearance, kept in the browser under a key of the app's own.
const COLOR_SCHEME = {
  storageKey: "next-example-color-scheme",
  defaultColorScheme: "system",
  enableSystem: true,
} as const satisfies ColorSchemeOptions;

/**
 * The document's title, in the request's language: each page's name, then the app's, as one message whose `{page}`
 * is Next's `%s`, so a translator orders the two.
 *
 * @returns The title template and the title of a page that sets none.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();

  return { title: { template: t("{page} · Back office", { page: "%s" }), default: t("Back office") } };
}

/**
 * The root layout: the request's locale, catalog, zone and formats reach the client components through the provider,
 * and the shell (sidebar, header, command menu) wraps every page, so it keeps its state while the pages change.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const intl = await getIntl();
  // The sidebar opens as the visitor left it, so the first frame paints it that way.
  const sidebarOpen = (await cookies()).get(SIDEBAR_COOKIE)?.value !== "false";

  return (
    // The color scheme script sets the scheme's class on <html> before React hydrates it.
    <html
      lang={intl.locale}
      {...documentAttributes({ theme: THEME, density: "dense" })}
      suppressHydrationWarning>
      <head>
        <ColorSchemeScript {...COLOR_SCHEME} />
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
      </body>
    </html>
  );
}
