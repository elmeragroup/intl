import { defineConfig } from "vitest/config";

// The unit tests, apart from the HTTP tests in tests/ (vitest.e2e.config.ts). No bundler plugin: the catalogs load from
// disk as the server loads them. The global setup runs `elmera-intl check` before any test, and fails the run on a
// catalog out of sync with the source.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["@elmeragroup/intl-tools/vitest"],
  },
});
