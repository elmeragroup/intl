import { defineConfig, devices } from "@playwright/test";

// The specs run against the production build `pnpm e2e` makes. The server and the browser both run in New York, so a
// date that renders 5 March proves the configured zone (Europe/Oslo) won over the host's. Port 3040: the intl-e2e
// fixtures hold 3020 and 3021, the examples' dev servers 3030 and 3031. No retries: a flake is fixed or deleted.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:3040",
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node_modules/.bin/next start -p 3040",
    url: "http://localhost:3040/api/greeting",
    env: { TZ: "America/New_York" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
