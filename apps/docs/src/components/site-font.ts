import localFont from "next/font/local";

/**
 * Inter, the site's face, loaded by `next/font/local` from the Latin WOFF2 files `@fontsource/inter` ships, so neither
 * the build nor a visitor's browser fetches a font from anywhere but this site. Its generated family is in
 * `--font-inter`, which `styles/globals.css` sets `--font-sans` from. Fuse's parts and the site set these four weights.
 */
export const inter = localFont({
  src: [
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2", weight: "500" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2", weight: "600" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2", weight: "700" },
  ],
  style: "normal",
  variable: "--font-inter",
});
