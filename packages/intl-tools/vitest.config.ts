import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const runtime = (file: string) => fileURLToPath(new URL(`../intl/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import the runtime by name, as an app would (the extractor keys off the specifier). Its source, not its
    // dist, so the extracted keys and the keys the runtime looks up come from the code under test without a build.
    alias: [
      { find: /^@elmeragroup\/intl\/core$/, replacement: runtime("src/core.ts") },
      { find: /^@elmeragroup\/intl\/internal\/message$/, replacement: runtime("src/message.ts") },
      { find: /^@elmeragroup\/intl\/internal\/icu$/, replacement: runtime("src/icu.ts") },
      { find: /^@elmeragroup\/intl\/internal\/catalog$/, replacement: runtime("src/catalog.ts") },
      // The runtime's formatter as it ships: built without the parser, so nothing here can format an unparsed string.
      {
        find: /^@elmeragroup\/intl\/internal\/formatter$/,
        replacement: runtime("dist/internal/formatter.js"),
      },
      { find: /^@elmeragroup\/intl\/(react|internal\/react-client)$/, replacement: runtime("src/react.tsx") },
      { find: /^@elmeragroup\/intl\/server$/, replacement: runtime("src/server.ts") },
      // The message corpus has one home, the runtime's tests; the extractor tests read the same file.
      { find: /^#corpus$/, replacement: runtime("test/fixtures.tsx") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
