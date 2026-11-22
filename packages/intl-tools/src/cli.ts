#!/usr/bin/env node
// `elmera-intl` executable: runs `executable` (cli-run.ts) as the process's main fiber.

import * as Runtime from "effect/Runtime";
import process, { cwd, stderr, stdout } from "node:process";

import { executable, exitCodeOf } from "./cli-run";

// A reader that closes the pipe early (`| head`) wants no more output, not a stack trace. A parent that spawned the
// CLI holds a socket, not a pipe, and on macOS its close can surface as ENOTCONN.
const READER_GONE = new Set(["EPIPE", "ENOTCONN"]);
stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (!READER_GONE.has(error.code ?? "")) {
    throw error;
  }
});

// effect's runMain for this process, as @effect/platform-node-shared's NodeRuntime.runMain but for its exit and signals.
// That one calls process.exit(), which cuts a report still flushing into a pipe at 64 KiB; this one sets
// process.exitCode to the program's own code on every exit, 0 included, as the CLI always has, and lets the loop drain.
// That one also takes SIGINT and SIGTERM for the whole run; here only a running watch takes them (cli-run.ts), and a
// signal ends any other command at once, as Node does by default.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => {
    teardown(exit, (code) => {
      process.exitCode = code;
    });
  });
});

runMain(
  executable({
    cwd: cwd(),
    stdout: (text) => stdout.write(text),
    stderr: (text) => stderr.write(text),
  }),
  {
    // Every failure is printed by the program itself: a usage error, the command's problems, a crash's stack.
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      onExit(exitCodeOf(exit));
    },
  }
);
