import type { Metadata } from "next";

import { landingMetadata } from "../../lib/og-metadata";

/** The landing's title and card. */
export const metadata: Metadata = landingMetadata();

/**
 * The landing page, empty until it has copy: the layout frames it.
 *
 * @returns Nothing yet.
 */
export default function LandingPage(): null {
  return null;
}
