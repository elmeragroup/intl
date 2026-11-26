import type { ReactElement, ReactNode } from "react";

import { SiteHeader } from "../../components/site-header";

type LandingLayoutProps = {
  readonly children: ReactNode;
};

/**
 * The landing's frame: the site header above the page.
 *
 * @returns The landing's body.
 */
export default function LandingLayout({ children }: LandingLayoutProps): ReactElement {
  return (
    <>
      <SiteHeader />
      <main>{children}</main>
    </>
  );
}
