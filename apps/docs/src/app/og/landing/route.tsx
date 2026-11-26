import { SITE_NAME } from "../../../lib/site";
import { OgCard } from "../../../og/og-card";
import { ogResponse } from "../../../og/og-response";

/** The image reads nothing from the request, so `next build` prerenders it. */
export const dynamic = "force-static";

/**
 * The landing's Open Graph image: the card with no subtitle.
 *
 * @returns The PNG.
 */
export function GET(): Response {
  return ogResponse(<OgCard wordmark={SITE_NAME} />);
}
