import type { ComponentProps, ReactElement } from "react";

const TITLE = "m-0 mb-[0.6rem] font-heading text-3xl font-semibold tracking-tight";

/**
 * A docs page's `<h1>`, which an MDX page's `#` heading renders as (mdx-components.tsx). The title's styles live here,
 * so the shell restyles no other heading.
 *
 * @returns The heading.
 */
export function DocsPageTitle({ className, ...props }: ComponentProps<"h1">): ReactElement {
  return <h1 className={className === undefined ? TITLE : `${TITLE} ${className}`} {...props} />;
}
