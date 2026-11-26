/**
 * The font the Open Graph card sets type in: Inter, read from `@fontsource/inter` (SIL OFL 1.1, its license ships in
 * the package). Satori takes TTF, OTF or WOFF, never WOFF2, and loads nothing over the network, so the card reads the
 * package's Latin WOFF files. Paths are relative to the app directory, the working directory of `next build` and of the
 * standalone `server.js`; `next.config.ts` lists the same files under `outputFileTracingIncludes`, so the standalone
 * bundle carries them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OG_FONT_FAMILY } from "./og-card";

/** The weights the card sets: 600 for the wordmark, 500 for the subtitle. */
const WEIGHTS = [500, 600] as const;

/** A font as `ImageResponse` takes it. */
type OgFont = {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: (typeof WEIGHTS)[number];
  readonly style: "normal";
};

/**
 * Inter in the weights the card sets.
 *
 * @returns The fonts for `ImageResponse`, a mutable array because its `fonts` option is one.
 */
export function loadOgFonts(): Array<OgFont> {
  return WEIGHTS.map((weight) => {
    // Tracing cannot resolve a path built at runtime and would otherwise pull in the whole project; next.config.ts
    // names these files instead.
    const file = readFileSync(
      join(
        /* turbopackIgnore: true */ process.cwd(),
        `node_modules/@fontsource/inter/files/inter-latin-${String(weight)}-normal.woff`
      )
    );

    return {
      name: OG_FONT_FAMILY,
      data: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
      weight,
      style: "normal",
    };
  });
}
