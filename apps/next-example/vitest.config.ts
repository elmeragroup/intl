import { defineConfig } from "vitest/config";

import { intlCatalogs } from "@elmeragroup/intl-tools/vite";

// The unit tests, apart from the Playwright specs in tests/. Next builds with Turbopack (withIntl in next.config.ts),
// but Vitest runs on Vite, so the tests take the Vite plugin: intlCatalogs() alone compiles `*.po` imports, without the
// dev watcher or the build's check; the global setup runs that check before any test, and fails the run on a catalog
// out of sync with the source.
export default defineConfig({
  plugins: [intlCatalogs()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["@elmeragroup/intl-tools/vitest"],
  },
});
