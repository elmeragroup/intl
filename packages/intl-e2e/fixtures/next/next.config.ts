import type { NextConfig } from "next";

import createMDX from "@next/mdx";

import { withIntl } from "@elmeragroup/intl-tools/next";

// @next/mdx composed as a Next.js host app with MDX pages composes it.
const withMDX = createMDX({ options: { remarkPlugins: [], rehypePlugins: [] } });

const base = {
  reactStrictMode: true,
  // next dev otherwise writes AGENTS.md into the fixture.
  agentRules: false,
  // These builds test the runtime and its packaging, so they run cold. `next dev` too: a dev start that restores the
  // dev cache can reload the page for ever on "HMR hash mismatch" (15 of 16 polled starts after a polled start, once
  // natively; #129), and CI starts without one.
  experimental: {
    agentUpgrade: false,
    turbopackFileSystemCacheForBuild: false,
    turbopackFileSystemCacheForDev: false,
  },
  turbopack: {
    rules: {
      // A rule already present, as a host app's config carries, so withIntl must append beside it.
      "*.mdx": { condition: { query: "?raw" }, type: "text" },
    },
  },
  typescript: { ignoreBuildErrors: true },
  // The dev server polls, as the Start fixture's does, so the dev-loop spec's PO save reaches it whatever the host's
  // file events do: on a busy macOS fseventsd delivered saves up to 17 s late, 1 of 25 never; polling 135 of 135
  // in 0.4 s at most. Turbopack polls only the directories it has read.
  watchOptions: { pollIntervalMs: 100 },
} satisfies NextConfig;

// Outermost, so withIntl sees the config the other wrappers produced. The request module sits off the default path, so
// the `request` option is what aliases it.
export default withIntl(withMDX(base), { dir: import.meta.dirname, request: "intl/fixture-request.ts" });
