import type { ReactElement, ReactNode } from "react";

import type { Metadata } from "next";

import { ColorSchemeScript, ThemeProvider } from "@elmeragroup/fuse/theme";

import { DocumentRoot } from "../components/document-root";
import { SITE_NAME } from "../lib/site";
import { siteOrigin } from "../lib/site-origin";
import { DOCUMENT_COLOR_SCHEME, DOCUMENT_THEME } from "../lib/theme";

/**
 * Every page's title is its own, then the product's, and its site-relative image URL resolves against the public
 * origin.
 */
export const metadata: Metadata = {
  metadataBase: siteOrigin(),
  title: { template: `%s · ${SITE_NAME}`, default: SITE_NAME },
};

type RootLayoutProps = {
  readonly children: ReactNode;
};

/**
 * The one root layout, so moving between the landing and the docs keeps the document: the color scheme script, which
 * sets the visitor's light or dark class on `<html>` before the first paint, and Fuse's theme provider around the
 * route groups' frames.
 *
 * @returns The document.
 */
export default function RootLayout({ children }: RootLayoutProps): ReactElement {
  return (
    <DocumentRoot suppressHydrationWarning>
      <head>
        <ColorSchemeScript {...DOCUMENT_COLOR_SCHEME} />
      </head>
      <body className="m-0 min-w-80 bg-background font-sans text-foreground antialiased">
        <ThemeProvider theme={DOCUMENT_THEME} {...DOCUMENT_COLOR_SCHEME} injectColorSchemeScript={false}>
          {children}
        </ThemeProvider>
      </body>
    </DocumentRoot>
  );
}
