import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    oxlint: "src/oxlint.ts",
    cli: "src/cli.ts",
    vitest: "src/vitest.ts",
    vite: "src/vite.ts",
    next: "src/next.ts",
    compile: "src/compile.ts",
    "po-loader": "src/po-loader.ts",
  },
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  dts: { sourcemap: true },
  clean: true,
  sourcemap: true,
  treeshake: true,
  platform: "node",
  // No `target`: tsdown derives it from `engines.node`, the tools' floor (`^24.14.0 || >=25.5.0`: node24.14.0).
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
