import type { ReactElement, ReactNode } from "react";

import { documentAttributes } from "@elmeragroup/fuse/theme";

import { DOCUMENT_THEME } from "../lib/theme";
import { inter } from "./site-font";

import "../styles/globals.css";

type DocumentRootProps = {
  readonly children: ReactNode;
  /** Set where a color scheme script rewrites `<html>`'s class before React hydrates it. */
  readonly suppressHydrationWarning?: boolean;
};

/**
 * The `<html>` every document renders (the root layout, the global error and not-found pages): English,
 * the site's font and stylesheet, and Fuse's theme at dense density, the look of an internal tool.
 *
 * @returns The document element around the layout's head and body.
 */
export function DocumentRoot({
  children,
  suppressHydrationWarning = false,
}: DocumentRootProps): ReactElement {
  return (
    <html
      lang="en"
      className={`${inter.variable} bg-background text-foreground`}
      {...documentAttributes({ theme: DOCUMENT_THEME, density: "dense" })}
      suppressHydrationWarning={suppressHydrationWarning}>
      {children}
    </html>
  );
}
