import type { ReactElement } from "react";

/** The one family the card sets type in, which og-fonts.ts loads. */
export const OG_FONT_FAMILY = "Inter";

/** Every Open Graph image is a 1200 × 630 PNG, the size Open Graph and X large cards crop to. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/**
 * The card's colors: Fuse's neutral dark background and its foregrounds. Satori draws inline styles only, so the card
 * cannot read the theme's custom properties.
 */
const COLORS = { background: "#0a0a0a", foreground: "#fafafa", mutedForeground: "#a1a1a1" } as const;

/** What the card draws. */
type OgCardProps = {
  /** The product name. */
  readonly wordmark: string;
  /** The line under the wordmark, such as a page title; the landing's card has none. */
  readonly subtitle?: string;
};

/**
 * The one Open Graph card: the wordmark and an optional subtitle, centred, since Slack and Teams crop a link preview to
 * the image's centre. A subtitle too long for one line wraps inside its 960px measure and clamps to two lines.
 *
 * @returns The card, for `ImageResponse`.
 */
export function OgCard({ wordmark, subtitle }: OgCardProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        backgroundColor: COLORS.background,
        fontFamily: OG_FONT_FAMILY,
      }}>
      <span
        style={{
          fontSize: 120,
          fontWeight: 600,
          lineHeight: "132px",
          letterSpacing: "-0.02em",
          color: COLORS.foreground,
        }}>
        {wordmark}
      </span>
      {subtitle === undefined ? null : (
        <span
          style={{
            display: "block",
            maxWidth: 960,
            fontSize: 56,
            fontWeight: 500,
            lineHeight: "68px",
            letterSpacing: "-0.01em",
            textAlign: "center",
            lineClamp: 2,
            color: COLORS.mutedForeground,
          }}>
          {subtitle}
        </span>
      )}
    </div>
  );
}
