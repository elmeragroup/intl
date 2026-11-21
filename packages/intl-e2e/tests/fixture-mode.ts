/**
 * Which packages the builds consume, per pass of scripts/e2e.ts: the workspace links, or `pnpm pack`'s copies installed
 * into each fixture.
 */
export const FIXTURE_RUNTIME: "linked" | "packed" =
  process.env.INTL_FIXTURE_RUNTIME === "packed" ? "packed" : "linked";

/** Which servers the pass runs: the production builds, or the dev servers (`next dev`, `vite dev`). */
export const FIXTURE_SERVER: "prod" | "dev" = process.env.INTL_FIXTURE_SERVER === "dev" ? "dev" : "prod";

/** The Next fixture's server. */
export const NEXT_URL = "http://localhost:3020";

/** The Start fixture's server. */
export const START_URL = "http://localhost:3021";
