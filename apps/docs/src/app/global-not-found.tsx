import type { ReactElement } from "react";

import type { Metadata } from "next";
import Link from "next/link";

import { DocumentRoot } from "../components/document-root";
import { DOCS_HOME } from "../lib/pages";
import { SITE_NAME } from "../lib/site";

/** The 404's title. */
export const metadata: Metadata = { title: `Page not found · ${SITE_NAME}` };

/**
 * The 404 for an address no route matches. It renders outside the root layout, as a document of its own, so it shows
 * neither route group's frame, and points back into the site.
 *
 * @returns The not-found document.
 */
export default function GlobalNotFound(): ReactElement {
  return (
    <DocumentRoot>
      <body className="m-0 grid min-h-dvh place-items-center bg-background p-6 font-sans text-foreground antialiased">
        <main className="flex max-w-md flex-col items-start gap-4">
          <h1 className="m-0 font-heading text-2xl font-semibold">Page not found</h1>
          <p className="m-0 text-muted-foreground">Nothing lives at this address.</p>
          <nav aria-label="Back into the site" className="flex flex-wrap gap-4">
            <Link href={DOCS_HOME.href} className="font-medium text-foreground underline underline-offset-4">
              Read the docs
            </Link>
            <Link href="/" className="font-medium text-foreground underline underline-offset-4">
              Go to the home page
            </Link>
          </nav>
        </main>
      </body>
    </DocumentRoot>
  );
}
