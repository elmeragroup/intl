import type { NextConfig } from "next";

import createMdx from "@next/mdx";
import { join } from "node:path";

const config = {
  reactStrictMode: true,
  // The container image runs `node apps/docs/server.js` from `.next/standalone` (Dockerfile), and so do `pnpm start` and
  // the e2e specs; the `build` script copies the static assets in, which Next leaves for the host. Tracing from the workspace root lays the bundle out as the workspace is, with pnpm's
  // dependencies copied in rather than left behind as symlinks.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  // The Open Graph routes read Inter from @fontsource with `fs` (src/og/og-fonts.ts), at build when they prerender and
  // in a request only if one renders again. Tracing cannot follow a path built at runtime, so the files are named here
  // and the standalone bundle carries them, with the SIL OFL 1.1 text that must travel with every copy of the font.
  outputFileTracingIncludes: {
    "/og/**": [
      "./node_modules/@fontsource/inter/files/inter-latin-{500,600}-normal.woff",
      "./node_modules/@fontsource/inter/LICENSE",
    ],
  },
  // Docs pages are `page.mdx` route files beside the TypeScript routes.
  pageExtensions: ["ts", "tsx", "mdx"],
  // next dev otherwise writes an AGENTS.md into the app.
  agentRules: false,
  // `pnpm type-check` (tsrs) checks the app; Next's own check would run a second compiler over it.
  typescript: { ignoreBuildErrors: true },
  // Responses do not advertise the framework.
  poweredByHeader: false,
  experimental: {
    // Serves src/app/global-not-found.tsx for an address no route matches: a document of its own, outside the root
    // layout, so a 404 renders neither a route group's frame nor the root layout's theme provider and script.
    globalNotFound: true,
  },
} satisfies NextConfig;

// No remark or rehype plugins: an MDX page is CommonMark with JSX until a docs page needs more.
const withMdx = createMdx({});

export default withMdx(config);
