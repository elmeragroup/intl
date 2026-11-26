import type { ReactElement, ReactNode } from "react";

import { SideNav } from "./side-nav";
import { SiteHeader } from "./site-header";
import { MAIN_CONTENT_ID, SkipNav } from "./skip-nav";

type DocsShellProps = {
  readonly children: ReactNode;
};

/**
 * The frame around every docs page: the skip link, the site header, the side nav, and the page in a column at the prose
 * measure.
 *
 * @returns The docs page's body.
 */
export function DocsShell({ children }: DocsShellProps): ReactElement {
  return (
    <>
      <SkipNav />
      <div className="min-h-dvh bg-background text-foreground">
        <SiteHeader />
        <div className="mx-auto grid max-w-[1200px] grid-cols-1 min-[45rem]:grid-cols-[240px_minmax(0,1fr)]">
          <SideNav />
          {/* Focusable by script only, so the skip link moves focus here and the next Tab continues in the page. */}
          <main
            className="w-full max-w-[720px] min-w-0 px-6 pt-10 pb-24 outline-none min-[45rem]:px-12"
            id={MAIN_CONTENT_ID}
            tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
