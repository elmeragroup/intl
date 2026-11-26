// `pnpm start`: the standalone server `next build` writes (the container image's), on the port src/lib/port.ts parses
// from PORT, the one the og:image fallback origin names. The server runs in this process, so it receives the signals
// `pnpm start` gets; it changes into its own directory before it serves.
import { parsePort } from "../src/lib/port.ts";

const port = parsePort(process.env.PORT);

if (port._tag === "err") {
  console.error(port.error.message);
  process.exit(1);
}

process.env.PORT = String(port.value);

await import(new URL("../.next/standalone/apps/docs/server.js", import.meta.url).href);
