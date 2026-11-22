// The CLI as a function of its arguments and output streams, so tests drive it without a process. Only
// `extract --watch` needs the process itself (its signals), so only `runMain` runs it.
import { relative, resolve } from "node:path";
import process from "node:process";

import type { CommandReport } from "./commands";
import { runCheck, runExtract } from "./commands";
import { describeProblem } from "./problem";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { WatchMode } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery, watchProject } from "./watch";

/** Where the CLI writes and resolves paths from. */
export type CliIo = {
  /** Directory the default config path is resolved in. */
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

const USAGE = `usage: elmera-intl <extract|check> [--json] [--config <path to ${CONFIG_FILE}>]
       elmera-intl extract --watch [--poll <ms>] [--config <path to ${CONFIG_FILE}>]`;

/**
 * Run `elmera-intl extract | check [--json] [--config <path>]`.
 *
 * @param args - The arguments after the program name.
 * @param io - Working directory and output streams.
 * @returns The exit code: 0 when clean, 1 on any problem, 2 on a usage error; rejects when the command throws.
 */
export function runCli(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  // A Promise, though the commands still run synchronously, so the hosts already await what becomes an Effect
  // program; Promise.try turns a throw into a rejection, which runGuarded maps to exit code 2.
  return Promise.try(runOnceOrUsage, args, io);
}

function runOnceOrUsage(args: ReadonlyArray<string>, io: CliIo): number {
  const parsed = parseArgs(args);

  if (parsed._tag === "Watch") {
    return usageError(
      io,
      "--watch runs only from the elmera-intl executable, which owns the process's signals"
    );
  }

  return parsed._tag === "UsageError" ? usageError(io, parsed.reason) : runOnce(parsed, io);
}

/**
 * Run the `elmera-intl` executable: every command, including `extract --watch`, which syncs until SIGINT or SIGTERM
 * and then exits 0. An unexpected exception is exit code 2 with the stack on stderr, as in `runGuarded`.
 *
 * @param args - The arguments after the program name.
 * @param io - Working directory and output streams.
 * @returns The exit code, once the command (or the watch) has ended.
 */
export async function runMain(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed._tag !== "Watch") {
    return runGuarded(args, io);
  }

  try {
    const loaded = loadConfig(resolve(io.cwd, parsed.config ?? CONFIG_FILE));

    if (loaded._tag === "ConfigInvalid") {
      io.stderr(`${describeProblem(loaded.problem)}\n`);

      return 1;
    }

    await watchUntilSignal(loaded.config, parsed.mode, io);

    return 0;
  } catch (error) {
    return failed(io, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

async function watchUntilSignal(config: ProjectConfig, mode: WatchMode, io: CliIo): Promise<void> {
  // Before the ready line: a signal sent on seeing it must find the handlers.
  const stop = Promise.withResolvers<void>();
  process.once("SIGINT", stop.resolve);
  process.once("SIGTERM", stop.resolve);
  const watcher = watchProject(
    config,
    (result) => {
      if (result._tag === "Written") {
        io.stdout(`wrote ${result.files.map((file) => relative(config.root, file)).join(", ")}\n`);
      } else if (result._tag === "Failed") {
        result.problems.forEach((problem) => {
          io.stderr(`${describeProblem(problem)}\n`);
        });
      }
    },
    undefined,
    mode
  );
  io.stdout(`watching ${config.root} for message changes; Ctrl-C stops\n`);
  await stop.promise;
  process.off("SIGINT", stop.resolve);
  process.off("SIGTERM", stop.resolve);
  await watcher.close();
}

function usageError(io: CliIo, reason: string): number {
  io.stderr(`${reason}\n${USAGE}\n`);

  return 2;
}

function runOnce(parsed: OnceArgs, io: CliIo): number {
  const { command, json } = parsed;
  const configPath = resolve(io.cwd, parsed.config ?? CONFIG_FILE);
  const loaded = loadConfig(configPath);
  const report: CommandReport =
    loaded._tag === "Config"
      ? command === "extract"
        ? runExtract(loaded.config)
        : runCheck(loaded.config)
      : { problems: [loaded.problem], messages: 0, written: [], unreachable: [] };

  if (json) {
    // stdout carries only the JSON document, so tooling can parse it.
    io.stdout(`${JSON.stringify({ ok: report.problems.length === 0, ...report }, null, 2)}\n`);
  } else {
    report.problems.forEach((problem) => {
      io.stderr(`${describeProblem(problem)}\n`);
    });
    const summary =
      command === "extract"
        ? `${report.messages} messages; wrote ${report.written.length} file(s)`
        : `${report.messages} messages; ${report.problems.length} problem(s)`;
    io.stdout(`${summary}\n`);
  }

  return report.problems.length === 0 ? 0 : 1;
}

/**
 * Run the CLI, turning an unexpected exception (a defect, or I/O the CLI does not classify) into exit code 2 with the
 * stack on stderr, so it never reads as exit 1 ("problems found").
 *
 * @param args - The arguments after the program name.
 * @param io - Working directory and output streams.
 * @returns The CLI's exit code, or 2 when it threw.
 */
export async function runGuarded(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  try {
    // Awaited inside the try: a returned rejection would pass the catch by.
    return await runCli(args, io);
  } catch (error) {
    return failed(io, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

function failed(io: CliIo, reason: string): number {
  io.stderr(`elmera-intl failed: ${reason}\n`);

  return 2;
}

type OnceArgs = {
  readonly _tag: "Once";
  readonly command: "extract" | "check";
  readonly json: boolean;
  readonly config: string | undefined;
};

type ParsedArgs =
  | OnceArgs
  | { readonly _tag: "Watch"; readonly config: string | undefined; readonly mode: WatchMode }
  | { readonly _tag: "UsageError"; readonly reason: string };

// Every argument is accounted for before anything runs: a typo'd flag must not pass as a clean check.
function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const [command, ...rest] = args;

  if (command !== "extract" && command !== "check") {
    return { _tag: "UsageError", reason: `unknown command: ${command ?? "(none)"}` };
  }

  let json = false;
  let watch = false;
  let config: string | undefined;
  let poll: WatchMode | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];

    if (arg === "--json" && !json) {
      json = true;
    } else if (arg === "--watch" && !watch) {
      watch = true;
    } else if (arg === "--config" && config === undefined) {
      const value = rest[i + 1];

      if (value === undefined || value.startsWith("--")) {
        return { _tag: "UsageError", reason: "--config needs a path" };
      }

      config = value;
      i += 1;
    } else if (arg === "--poll" && poll === undefined) {
      const value = rest[i + 1] ?? "";
      const mode = /^\d+$/u.test(value) ? pollEvery(Number(value)) : undefined;

      if (mode === undefined) {
        return { _tag: "UsageError", reason: "--poll needs an interval in milliseconds, such as --poll 200" };
      }

      if (mode._tag === "PollIntervalOutOfRange") {
        return {
          _tag: "UsageError",
          reason: `--poll ${value}: the interval must be between ${MIN_POLL_MS} and ${MAX_POLL_MS} milliseconds`,
        };
      }

      poll = mode;
      i += 1;
    } else {
      return { _tag: "UsageError", reason: `unexpected argument: ${arg ?? ""}` };
    }
  }

  if (watch && (command !== "extract" || json)) {
    return { _tag: "UsageError", reason: "--watch goes with extract only, without --json" };
  }

  if (poll !== undefined && !watch) {
    return { _tag: "UsageError", reason: "--poll goes with extract --watch only" };
  }

  return watch
    ? {
        _tag: "Watch",
        config,
        mode: poll ?? { _tag: "native" },
      }
    : { _tag: "Once", command, json, config };
}
