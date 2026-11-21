import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const runtime = (file: string) => fileURLToPath(new URL(`../intl/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import the runtime by name, as an app would (the extractor keys off the specifier). Its source, not its
    // dist, so the extracted keys and the keys the runtime looks up come from the code under test without a build.
    alias: [
      { find: /^@elmeragroup\/intl\/core$/u, replacement: runtime("src/core.ts") },
      { find: /^@elmeragroup\/intl\/internal\/message$/u, replacement: runtime("src/message.ts") },
      { find: /^@elmeragroup\/intl\/internal\/icu$/u, replacement: runtime("src/icu.ts") },
      { find: /^@elmeragroup\/intl\/internal\/catalog$/u, replacement: runtime("src/catalog.ts") },
      // The runtime's formatter as it ships: built without the parser, so nothing here can format an unparsed string.
      {
        find: /^@elmeragroup\/intl\/internal\/formatter$/u,
        replacement: runtime("dist/internal/formatter.js"),
      },
      {
        find: /^@elmeragroup\/intl\/(react|internal\/react-client)$/u,
        replacement: runtime("src/react.tsx"),
      },
      { find: /^@elmeragroup\/intl\/server$/u, replacement: runtime("src/server.ts") },
      // The message corpus has one home, the runtime's tests; the extractor tests read the same file.
      { find: /^#corpus$/u, replacement: runtime("test/fixtures.tsx") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
