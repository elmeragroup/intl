import { notFound } from "next/navigation";

import { DOCS_PAGES, docsPageAt, docsSegments } from "../../../../lib/pages";
import { SITE_NAME } from "../../../../lib/site";
import { OgCard } from "../../../../og/og-card";
import { ogResponse } from "../../../../og/og-response";

/**
 * The handler's route context, written here rather than through Next's generated `RouteContext`, which exists only
 * after `next typegen`. The optional catch-all is absent for the bare `/og/docs`.
 */
type DocsImageContext = {
  /** The catch-all segments, as Next passes them to a route handler. */
  readonly params: Promise<{ readonly path?: ReadonlyArray<string> }>;
};

/** The docs pages are a closed set: an address outside it answers 404 instead of rendering on request. */
export const dynamicParams = false;

/**
 * One image per docs page, at its address under `/og`. `next build` prerenders every one, so a card that throws fails
 * the build rather than the first share.
 *
 * @returns The catch-all segments of each docs page.
 */
export function generateStaticParams(): Array<{ readonly path: ReadonlyArray<string> }> {
  return DOCS_PAGES.map((page) => ({ path: docsSegments(page.href) }));
}

/**
 * A docs page's Open Graph image: the card with the page's title.
 *
 * @returns The PNG.
 */
export async function GET(_request: Request, { params }: DocsImageContext): Promise<Response> {
  const { path = [] } = await params;
  const page = docsPageAt(path);

  if (page === undefined) {
    notFound();
  }

  return ogResponse(<OgCard wordmark={SITE_NAME} subtitle={page.title} />);
}
