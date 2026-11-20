import { defineConfig, devices } from "@playwright/test";

import { FIXTURE_SERVER, NEXT_URL, START_URL } from "./tests/fixture-mode.ts";

// Playwright's defaults for the builds; a dev server compiles each route on its first request.
const TIMEOUTS =
  FIXTURE_SERVER === "dev"
    ? { timeout: 60_000, expect: { timeout: 20_000 } }
    : { timeout: 30_000, expect: { timeout: 5_000 } };

// Serves the production builds scripts/e2e.ts made for the pass, or the fixtures' dev servers in the dev pass. No
// retries: a flake is fixed or deleted.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"] },
  ...TIMEOUTS,
  webServer: [
    {
      command:
        FIXTURE_SERVER === "dev"
          ? "../../node_modules/.bin/next dev -p 3020"
          : "../../node_modules/.bin/next start -p 3020",
      cwd: "fixtures/next",
      url: `${NEXT_URL}/parser-only`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        FIXTURE_SERVER === "dev" ? "../../node_modules/.bin/vite dev" : "node .output/server/index.mjs",
      cwd: "fixtures/start",
      url: `${START_URL}/three`,
      env: { PORT: "3021" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
