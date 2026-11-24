import { defineConfig, devices } from "@playwright/test";

// The specs run against the production build `pnpm e2e` makes. The server and the browser both run in New York, so a
// date that renders in Oslo's day (an invoice due on 20 March, still 19 March in New York) proves the configured zone
// (Europe/Oslo) won over the host's. Port 3041: the intl-e2e
// fixtures hold 3020 and 3021, the examples' dev servers 3030 and 3031, the Next example's specs 3040. No retries: a flake is fixed or deleted.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3041",
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
  },
  projects: [
    // Every spec, in Chromium.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The English overview's hydration case alone, in WebKit. Node's ICU and WebKit's write some dates differently
    // (English "Mar 29, 2026, 1:20 PM" against "Mar 29, 2026 at 1:20 PM"), which is why a hydrating component renders
    // strings the server formatted instead of formatting them again: here a component that formats a date itself
    // fails hydration, where Chromium, whose ICU writes what Node's does, would let it pass.
    {
      name: "webkit-hydrates-server-dates",
      use: { ...devices["Desktop Safari"] },
      grep: /in en hydrates \/ and updates it in the browser without an error/u,
    },
  ],
  webServer: {
    command: "node .output/server/index.mjs",
    url: "http://localhost:3041/api/greeting",
    env: { PORT: "3041", TZ: "America/New_York" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
