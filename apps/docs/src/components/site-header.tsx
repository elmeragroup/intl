import type { ReactElement } from "react";

import Link from "next/link";

import { DOCS_HOME } from "../lib/pages";
import { SITE_NAME } from "../lib/site";

const LINK =
  "text-sm flex min-h-7 items-center rounded-md px-2.5 text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The header on every page: the product name, home to the landing, and the way into the docs.
 *
 * @returns The site's banner.
 */
export function SiteHeader(): ReactElement {
  return (
    <header className="sticky top-0 z-10 flex h-docs-header items-center gap-x-6 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-6">
      <Link
        href="/"
        className="text-base font-semibold text-foreground no-underline focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {SITE_NAME}
      </Link>
      <nav aria-label="Site" className="ml-auto flex items-center gap-3">
        <Link href={DOCS_HOME.href} className={LINK}>
          Docs
        </Link>
      </nav>
    </header>
  );
}
