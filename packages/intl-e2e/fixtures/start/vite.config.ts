import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

import { intl } from "@elmeragroup/intl-tools/vite";

// The plugin stack of a TanStack Start host app: Start, React and Nitro.
export default defineConfig({
  // The dev server polls (and the intl plugin's extract watch with it), so the dev-loop spec's PO save reaches it
  // whatever the host's file events do (macOS delivers them through fseventsd, which a busy host delays or drops).
  server: { port: 3021, watch: { usePolling: true, interval: 100 } },
  plugins: [...intl(), tanstackStart(), nitro(), viteReact()],
});
