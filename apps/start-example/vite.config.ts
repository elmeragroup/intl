import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

import { intl } from "@elmeragroup/intl-tools/vite";

export default defineConfig({
  server: { port: 3031 },
  build: {
    rolldownOptions: {
      // Fuse marks its interactive modules "use client" for React Server Components; Start renders no server
      // components, so the directive means nothing here and the bundler's note about dropping it is noise.
      onLog(level, log, handler) {
        if (log.code !== "MODULE_LEVEL_DIRECTIVE") {
          handler(level, log);
        }
      },
    },
  },
  // intl() first: it compiles `*.po` imports, runs `elmera-intl extract --watch` beside `vite dev`, and runs
  // `elmera-intl check` before `vite build`, which fails on a catalog out of sync. tailwindcss() builds the stylesheet
  // (src/styles.css): Tailwind v4 with Fuse's components and themes.
  plugins: [...intl(), tailwindcss(), tanstackStart(), nitro(), viteReact()],
});
