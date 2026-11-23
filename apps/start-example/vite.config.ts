import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

import { intl } from "@elmeragroup/intl-tools/vite";

export default defineConfig({
  server: { port: 3031 },
  // intl() first: it compiles `*.po` imports, runs `elmera-intl extract --watch` beside `vite dev`, and runs
  // `elmera-intl check` before `vite build`, which fails on a catalog out of sync.
  plugins: [...intl(), tanstackStart(), nitro(), viteReact()],
});
