import { createRequire } from "node:module";
import type { UserConfig } from "tsdown";
import { defineConfig } from "tsdown";

const shared: UserConfig = {
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  sourcemap: true,
  treeshake: true,
  platform: "neutral",
  target: "es2022",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
};

// intl-messageformat's own parser dependency (pnpm keeps it out of this package's reach), swapped for its
// parser-free build: formatting a compiled AST needs only the parser package's type guards.
const noParser = createRequire(createRequire(import.meta.url).resolve("intl-messageformat")).resolve(
  "@formatjs/icu-messageformat-parser/no-parser.js"
);

export default defineConfig([
  {
    ...shared,
    entry: {
      core: "src/core.ts",
      react: "src/react.tsx",
      "react-server": "src/react-server.tsx",
      server: "src/server.ts",
      next: "src/next.tsx",
      "next-server": "src/next-server.ts",
      start: "src/start.tsx",
      effect: "src/effect.ts",
      "internal/catalog": "src/catalog.ts",
      "internal/icu": "src/icu.ts",
      "internal/message": "src/message.ts",
      "internal/request-config": "src/request-config.ts",
      "internal/request-config-server": "src/request-config-server.ts",
    },
    dts: { sourcemap: true },
    clean: true,
    // Self-specifiers stay imports: react-server reaches the "use client" provider through one, so the provider stays
    // in react.js behind its directive.
    deps: { neverBundle: [/^@elmeragroup\/intl\//u] },
  },
  {
    ...shared,
    // The runtime's only formatter: intl-messageformat bundled without its parser, so no runtime path can parse.
    entry: { "internal/formatter": "src/formatter.ts" },
    dts: { sourcemap: true },
    clean: false,
    deps: { alwaysBundle: ["intl-messageformat", /^@formatjs\//u] },
    alias: { "@formatjs/icu-messageformat-parser": noParser },
  },
]);
