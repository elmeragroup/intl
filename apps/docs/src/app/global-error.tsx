"use client";

import type { ReactElement } from "react";

import { Button } from "@elmeragroup/fuse/button";

import { DocumentRoot } from "../components/document-root";
import { SITE_NAME } from "../lib/site";

type GlobalErrorProps = {
  /** The error no nearer boundary caught. */
  readonly error: Error & { readonly digest?: string };
  /** Fetches and renders the failed layout again. */
  readonly retry: () => void;
};

/**
 * The last resort for an error no nearer boundary caught, such as one in a root layout. It replaces the whole document,
 * so it renders its own `<html>`, styles and title.
 *
 * @returns The error document.
 */
export default function GlobalError({ retry }: GlobalErrorProps): ReactElement {
  return (
    <DocumentRoot>
      <body className="m-0 grid min-h-dvh place-items-center bg-background p-6 font-sans text-foreground antialiased">
        <title>{`Something went wrong · ${SITE_NAME}`}</title>
        <main className="flex max-w-md flex-col items-start gap-4">
          <h1 className="m-0 font-heading text-2xl font-semibold">Something went wrong</h1>
          <p className="m-0 text-muted-foreground">
            This page could not be shown. Try again, or reload the page if the site was just updated.
          </p>
          <Button onClick={retry}>Try again</Button>
        </main>
      </body>
    </DocumentRoot>
  );
}
