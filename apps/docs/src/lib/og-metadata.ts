/**
 * The Open Graph and X card metadata every page carries, and the image routes it points at. The image URLs are
 * site-relative; the root layout sets `metadataBase` from `site-origin.ts`, and Next resolves them to the absolute URLs
 * Open Graph and X require.
 */

import type { Metadata } from "next";

import { OG_SIZE } from "../og/og-card";
import type { DocsPage } from "./pages";
import { SITE_NAME } from "./site";

/** The landing's image route. */
const OG_LANDING_PATH = "/og/landing";

/** What a page's card shows. */
type OgCard = {
  /** The image route, site-relative. */
  readonly image: string;
  /** What the image shows, for readers who cannot see it. */
  readonly alt: string;
};

/**
 * The `openGraph` and `twitter` members of a page's metadata. Next fills the card's title from the page's own resolved
 * metadata, and the X card's title and image from Open Graph.
 *
 * @param card - The page's card.
 * @returns Metadata members naming the image, its size and alt text, as a large X card.
 */
function ogMetadata(card: OgCard): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      images: [{ url: card.image, alt: card.alt, ...OG_SIZE, type: "image/png" }],
    },
    twitter: { card: "summary_large_image" },
  };
}

/**
 * The landing's metadata.
 *
 * @returns Its title and its card.
 */
export function landingMetadata(): Metadata {
  return { title: { absolute: SITE_NAME }, ...ogMetadata({ image: OG_LANDING_PATH, alt: SITE_NAME }) };
}

/**
 * A docs page's metadata, from its entry in the page list: its title, which the root layout's template suffixes, and
 * its card under `/og/docs`.
 *
 * @param page - The page's entry.
 * @returns The page's metadata.
 */
export function docsPageMetadata(page: DocsPage): Metadata {
  return {
    title: page.title,
    ...ogMetadata({ image: `/og${page.href}`, alt: `${SITE_NAME}: ${page.title}` }),
  };
}
