// The top of every page, ported from Fuse's app-shell block (page-header.tsx at Fuse 9be80460): its heading and
// description, already translated by the page, and the page's own actions at the end, and the document's title.
import type { ReactNode } from "react";

import { Heading } from "@elmeragroup/fuse/heading";
import { Text } from "@elmeragroup/fuse/text";
import { useT } from "@elmeragroup/intl/react";

/**
 * A page's heading, description and actions, and the document's title: the page's name, then the app's. React hoists
 * the `<title>` into the document's head, on the server and after each navigation and switch.
 *
 * @param props - The page's translated title and description, and buttons or a status at the header's end.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  const t = useT();

  return (
    <div className="md:px-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pt-6 pb-2">
      {/* One message, the page's name a placeholder in it, so a translator orders the two. */}
      <title>{t("{page} · Back office", { page: title })}</title>
      {/* Takes focus from script only: the shell moves focus to the page's title after a client navigation, without a
          ring, since no key put it there. */}
      <div data-page-title tabIndex={-1} className="flex min-w-0 flex-col gap-1 outline-none">
        <Heading level={1} size="2xl" noMargin>
          {title}
        </Heading>
        <Text variant="muted" size="sm">
          {description}
        </Text>
      </div>
      {children === undefined ? null : <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
