"use client";

import type { ReactElement } from "react";

import { Button } from "@elmeragroup/fuse/button";

import { StatusDocument } from "../components/status-document";
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
    <StatusDocument heading="Something went wrong">
      <title>{`Something went wrong · ${SITE_NAME}`}</title>
      <p className="m-0 text-muted-foreground">
        This page could not be shown. Try again, or reload the page if the site was just updated.
      </p>
      <Button onClick={retry}>Try again</Button>
    </StatusDocument>
  );
}
