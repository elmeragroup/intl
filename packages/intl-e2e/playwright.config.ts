import { defineConfig, devices } from "@playwright/test";

import { FIXTURE_SERVER, NEXT_URL, START_URL } from "./tests/fixture-mode.ts";

// The test timeout: Playwright's default for the builds, twice it for a dev server, which compiles each route on its
// first request. A timeout is only a hang guard (AGENTS.md, Tests). `timeout: 0` below removes an expectation's own
// timeout in both passes, for `expect` and `expect.poll` alike, so the test's timeout bounds it: an outcome that is
// correct but late passes, and one that never comes still fails, by the test's timeout, naming the expectation and
// what it last received. Here, a server action's result held past 5 s failed at the old 5 s bound and passes now; the
// examples' hydration, navigations and refreshed renders came past 5 s under load, and the fixtures do the same work.
const TIMEOUTS = FIXTURE_SERVER === "dev" ? { timeout: 60_000 } : { timeout: 30_000 };

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
  expect: { timeout: 0 },
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
