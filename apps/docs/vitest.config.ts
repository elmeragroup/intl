import { defineConfig } from "vitest/config";

// The unit tests, apart from the Playwright specs in tests/: the site's pure logic.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
