"use client";

import type { ReactElement } from "react";

import { Button } from "@elmeragroup/fuse/button";

import { DocsPageTitle } from "../../components/docs-page-title";

type DocsErrorProps = {
  /** The error the page threw. */
  readonly error: Error & { readonly digest?: string };
  /** Fetches and renders the failed page again. */
  readonly retry: () => void;
};

/**
 * A docs page that failed to render. The docs shell and its nav stay around it.
 *
 * @returns The page's replacement.
 */
export default function DocsError({ retry }: DocsErrorProps): ReactElement {
  return (
    <section aria-labelledby="docs-error-title" className="flex flex-col items-start gap-4">
      <DocsPageTitle id="docs-error-title">This page could not load</DocsPageTitle>
      <p className="m-0 text-muted-foreground">
        Try again, or reload the page if the site was just updated. The navigation still works.
      </p>
      <Button onClick={retry}>Try again</Button>
    </section>
  );
}
