import type { NextConfig } from "next";

import { withIntl } from "@elmeragroup/intl-tools/next";

const config = {
  reactStrictMode: true,
  // next dev otherwise writes an AGENTS.md into the app.
  agentRules: false,
  // `pnpm type-check` (tsrs) checks the app; Next's own check would run a second compiler over it.
  typescript: { ignoreBuildErrors: true },
} satisfies NextConfig;

// Outermost, so it sees the config every other wrapper produced: it adds the rule that compiles `*.po` imports.
export default withIntl(config, { dir: import.meta.dirname });
