import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

import { intl } from "@elmeragroup/intl-tools/vite";

// The plugin stack of a TanStack Start host app: Start, React and Nitro.
export default defineConfig({
  server: { port: 3021 },
  plugins: [...intl(), tanstackStart(), nitro(), viteReact()],
});
