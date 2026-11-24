import { defineConfig } from "vitest/config";

// The HTTP tests (`pnpm e2e`): the server started as `node src/main.ts`, as it runs, and asked over HTTP. A process of
// its own, not the app imported into Vitest, whose transform would accept what Node's type stripping refuses (an
// import without its `.ts`, syntax Node cannot erase), so only a real start proves the API runs as written.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
