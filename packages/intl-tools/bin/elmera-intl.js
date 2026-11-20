#!/usr/bin/env node
// Committed shim: pnpm links bins at install, before dist exists, and a bin pointing into dist warns on every fresh
// install. This file always exists; the CLI itself runs from the build.
import { existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  process.stderr.write("elmera-intl is not built: run `pnpm --filter @elmeragroup/intl-tools build`\n");
  process.exit(2);
}

await import(cli.href);
