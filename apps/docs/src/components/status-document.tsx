import type { ReactElement, ReactNode } from "react";

import { DocumentRoot } from "./document-root";

type StatusDocumentProps = {
  /** The page's one heading, which says what happened. */
  readonly heading: string;
  /** What follows the heading: an explanation and the way back. */
  readonly children: ReactNode;
};

/**
 * A whole document that only reports a status, for the pages that render outside the root layout (the global error
 * and not-found pages): the heading and its message, centred, in neither route group's frame.
 *
 * @returns The status document.
 */
export function StatusDocument({ heading, children }: StatusDocumentProps): ReactElement {
  return (
    <DocumentRoot>
      <body className="m-0 grid min-h-dvh place-items-center bg-background p-6 font-sans text-foreground antialiased">
        <main className="flex max-w-md flex-col items-start gap-4">
          <h1 className="m-0 font-heading text-2xl font-semibold">{heading}</h1>
          {children}
        </main>
      </body>
    </DocumentRoot>
  );
}
