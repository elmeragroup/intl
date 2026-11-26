import type { ReactElement, ReactNode } from "react";

import { DocsShell } from "../../components/docs-shell";

type DocsLayoutProps = {
  readonly children: ReactNode;
};

/**
 * The docs' frame: every docs page inside the docs shell, which keeps its nav while the pages change.
 *
 * @returns The docs' body.
 */
export default function DocsLayout({ children }: DocsLayoutProps): ReactElement {
  return <DocsShell>{children}</DocsShell>;
}
