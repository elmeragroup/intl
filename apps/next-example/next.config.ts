import type { NextConfig } from "next";

import { withIntl } from "@elmeragroup/intl-tools/next";

// Annotated as NextConfig, not `satisfies NextConfig`: withIntl's parameter type shares no property with a literal that
// sets neither `turbopack` nor `outputFileTracingRoot`, so the `satisfies` form fails to type-check (#21).
const config: NextConfig = {
  reactStrictMode: true,
  // next dev otherwise writes an AGENTS.md into the app.
  agentRules: false,
  // `pnpm type-check` (tsrs) checks the app; Next's own check would run a second compiler over it.
  typescript: { ignoreBuildErrors: true },
};

// Outermost, so it sees the config every other wrapper produced: it adds the rule that compiles `*.po` imports.
export default withIntl(config, { dir: import.meta.dirname });
