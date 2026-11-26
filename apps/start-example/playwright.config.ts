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
  // A timeout is only a hang guard (AGENTS.md, Tests). `timeout: 0` removes an expectation's own timeout, for `expect`
  // and `expect.poll` alike, so the test's timeout bounds it: an outcome that is correct but late under load passes,
  // and one that never comes still fails, by the test's timeout, naming the expectation and what it last received.
  // Under a load spike these came past Playwright's default 5 s: a page's own hydration (the metering points' search
  // was still disabled at 5 s in 2 of 2 runs) and its deferred count (1 of 3), while the overview's case spent some
  // 23 s on its expectations before its click. The router pushes the URL as a click lands and renders the destination
  // once its loader answers: with that answer held past 5 s, the heading's check failed at 5 s and passes now.
  expect: { timeout: 0 },
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
