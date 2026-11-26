import type { ReactElement } from "react";

import { ImageResponse } from "next/og";

import { OG_SIZE } from "./og-card";
import { loadOgFonts } from "./og-fonts";

/**
 * Render an Open Graph card to a 1200 × 630 PNG response with Inter loaded. Every image prerenders at build, and a given
 * URL changes only with a deploy, so a cache header lets an unfurler keep it.
 *
 * @param element - The drawing, an `OgCard`.
 * @returns The PNG response.
 */
export function ogResponse(element: ReactElement): ImageResponse {
  return new ImageResponse(element, {
    ...OG_SIZE,
    fonts: loadOgFonts(),
    headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
