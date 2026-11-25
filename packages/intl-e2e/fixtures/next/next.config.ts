import type { NextConfig } from "next";

import createMDX from "@next/mdx";

import { withIntl } from "@elmeragroup/intl-tools/next";

// @next/mdx composed as a Next.js host app with MDX pages composes it.
const withMDX = createMDX({ options: { remarkPlugins: [], rehypePlugins: [] } });

const base = {
  reactStrictMode: true,
  // next dev otherwise writes AGENTS.md into the fixture.
  agentRules: false,
  // These builds test the runtime and its packaging, so they run cold.
  experimental: { agentUpgrade: false, turbopackFileSystemCacheForBuild: false },
  turbopack: {
    rules: {
      // A rule already present, as a host app's config carries, so withIntl must append beside it.
      "*.mdx": { condition: { query: "?raw" }, type: "text" },
    },
  },
  typescript: { ignoreBuildErrors: true },
} satisfies NextConfig;

// Outermost, so withIntl sees the config the other wrappers produced. The request module sits off the default path, so
// the `request` option is what aliases it.
export default withIntl(withMDX(base), { dir: import.meta.dirname, request: "intl/fixture-request.ts" });
