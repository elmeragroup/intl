import { defineConfig, devices } from "@playwright/test";

// The specs run against the standalone server the container image runs, from the production build `pnpm e2e` makes
// with DOCS_ORIGIN set to this server's origin, so the og:image URLs the specs check are the origin they chose. Port
// 3042: the intl-e2e fixtures hold 3020 and 3021, the examples' dev servers 3030 to 3032, the docs' 3033, and the
// examples' specs 3040 and 3041. No retries: a flake is fixed or deleted.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3042",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The server directly, not through `pnpm start`: pnpm runs a script in a process group of its own, which Playwright's
  // teardown does not reach, so the run would wait on the server after the last spec.
  webServer: {
    command: "node server.js",
    cwd: ".next/standalone/apps/docs",
    url: "http://localhost:3042/og/landing",
    // server.js binds HOSTNAME, and the address it reaches for its own origin falls back to the machine's name.
    env: { PORT: "3042", HOSTNAME: "localhost" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
