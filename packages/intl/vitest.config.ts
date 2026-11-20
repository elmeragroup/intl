import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (file: string) => fileURLToPath(new URL(`./${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import the package by name, as an app would.
    alias: [
      { find: /^@elmeragroup\/intl\/core$/, replacement: path("src/core.ts") },
      { find: /^@elmeragroup\/intl\/internal\/message$/, replacement: path("src/message.ts") },
      { find: /^@elmeragroup\/intl\/internal\/icu$/, replacement: path("src/icu.ts") },
      { find: /^@elmeragroup\/intl\/internal\/catalog$/, replacement: path("src/catalog.ts") },
      // The formatter as it ships, built without the parser (turbo.json builds before tests): every test formats
      // through the runtime that reaches browsers, which cannot parse.
      { find: /^@elmeragroup\/intl\/internal\/formatter$/, replacement: path("dist/internal/formatter.js") },
      { find: /^@elmeragroup\/intl\/(react|internal\/react-client)$/, replacement: path("src/react.tsx") },
      { find: /^@elmeragroup\/intl\/server$/, replacement: path("src/server.ts") },
      // Catalogs come from the one compiler, as apps get them. Not a package dependency: intl-tools depends on this
      // package, so the tests reach its source directly (as its tests reach the corpus here).
      { find: /^#compile$/, replacement: path("../intl-tools/src/compile.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    // The date checks prove the configured zone wins, so the host zone must differ from it.
    env: { TZ: "America/Los_Angeles" },
  },
});
