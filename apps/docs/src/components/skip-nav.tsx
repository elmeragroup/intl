import type { ReactElement } from "react";

/** The id of the docs shell's main column, which the skip link targets. */
export const MAIN_CONTENT_ID = "main-content";

/**
 * The first focusable element on a docs page: hidden until focused, it jumps past the header and the side nav.
 *
 * @returns The skip link.
 */
export function SkipNav(): ReactElement {
  return (
    <a
      className="absolute m-[-1px] h-px w-px overflow-hidden border-0 p-0 whitespace-nowrap [clip-path:inset(50%)] focus-visible:top-0 focus-visible:left-0 focus-visible:z-20 focus-visible:m-0 focus-visible:inline-flex focus-visible:h-docs-header focus-visible:w-auto focus-visible:items-center focus-visible:overflow-visible focus-visible:bg-background focus-visible:px-3 focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:[clip-path:none]"
      href={`#${MAIN_CONTENT_ID}`}>
      Skip to contents
    </a>
  );
}
