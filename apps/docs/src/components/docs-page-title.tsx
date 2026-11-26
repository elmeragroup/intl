import type { ComponentProps, ReactElement } from "react";

const TITLE = "m-0 mb-[0.6rem] font-heading text-3xl font-semibold tracking-tight";

/**
 * A docs page's `<h1>`. An MDX page renders its title from its entry in the page list (src/lib/pages.ts) with it, and
 * the docs error page renders its own; the title's styles live here.
 *
 * @returns The heading.
 */
export function DocsPageTitle({ className, ...props }: ComponentProps<"h1">): ReactElement {
  return <h1 className={className === undefined ? TITLE : `${TITLE} ${className}`} {...props} />;
}
