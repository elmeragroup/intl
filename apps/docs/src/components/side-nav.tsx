"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { DOCS_PAGES } from "../lib/pages";

/**
 * The docs' side nav, from the page list, with the page on screen marked current.
 *
 * @returns The docs navigation.
 */
export function SideNav(): ReactElement {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Docs"
      className="border-r border-border px-4 pt-6 pb-16 text-sm min-[45rem]:sticky min-[45rem]:top-docs-header min-[45rem]:h-[calc(100dvh_-_var(--spacing-docs-header))] min-[45rem]:overflow-y-auto">
      <ul className="m-0 list-none p-0">
        {DOCS_PAGES.map((page) => (
          <li key={page.href}>
            <Link
              className="block rounded-lg px-2.5 py-1 text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-accent-foreground"
              href={page.href}
              aria-current={pathname === page.href ? "page" : undefined}>
              {page.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
