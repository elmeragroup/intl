#!/usr/bin/env node
// `elmera-intl` executable: see cli-run.ts. Sets the exit code instead of calling exit(), which would cut a report
// still flushing into a pipe at 64 KiB.
import process, { argv, cwd, stderr, stdout } from "node:process";

import { runMain } from "./cli-run";

// A reader that closes the pipe early (`| head`) wants no more output, not a stack trace. A parent that spawned the
// CLI holds a socket, not a pipe, and on macOS its close can surface as ENOTCONN.
const READER_GONE = new Set(["EPIPE", "ENOTCONN"]);
stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (!READER_GONE.has(error.code ?? "")) {
    throw error;
  }
});

process.exitCode = await runMain(argv.slice(2), {
  cwd: cwd(),
  stdout: (text) => stdout.write(text),
  stderr: (text) => stderr.write(text),
});
