// The `elmera-intl` executable's program: the arguments parse into a command line, read once left to right
// (`parseArgs`), a one-shot command runs through command-run.ts (which the hosts call directly), and a watch runs until
// a signal stops it.

import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import { basename, relative, resolve } from "node:path";
import process from "node:process";

import type { OneShotCommand } from "./command-run";
import { printProblems, ProblemsFound, reportCrash, runOnce } from "./command-run";
import { CONFIG_FILE } from "./project-config";
import { readConfigSnapshot } from "./project-config-read";
import type { ReporterIo } from "./reporter";
import { Reporter } from "./reporter";
import type { SyncResult, WatchMode } from "./watch";
import { hostServices, MAX_POLL_MS, MIN_POLL_MS, pollEvery } from "./watch";
import { followConfig } from "./watch-follow";

/** The directory the default config path resolves in. */
export type CliOptions = {
  /** Directory the default config path is resolved in. */
  readonly cwd: string;
};

/** Where the CLI writes and resolves paths from. */
export type CliIo = ReporterIo & CliOptions;

const USAGE = `usage: elmera-intl <extract|check> [--json] [--config <path to ${CONFIG_FILE}>]
       elmera-intl extract --watch [--poll <ms>] [--config <path to ${CONFIG_FILE}>]`;

/** Arguments the CLI refuses, with the reason it prints above the usage text. Exit code 2. */
export class UsageError
  extends /* @__PURE__ */ Schema.TaggedError<UsageError>()("UsageError", { reason: Schema.String })
{
  /** Usage errors exit 2, apart from 1, "problems found". */
  override readonly [Runtime.errorExitCode] = 2;
}

/** Every way the program fails, each carrying its exit code. */
export type CliFailure = UsageError | ProblemsFound;

/** A command line the CLI runs, its config path as given (the program resolves it in the working directory). */
type CommandLine =
  | {
      readonly _tag: "Once";
      readonly command: OneShotCommand;
      readonly json: boolean;
      readonly config: string;
    }
  | { readonly _tag: "Watch"; readonly config: string; readonly mode: WatchMode };

const WATCH_WITHOUT_EXTRACT = "--watch goes with extract only, without --json";
const POLL_WITHOUT_WATCH = "--poll goes with extract --watch only";

const refuse = (reason: string) => new UsageError({ reason });

// A `--poll` value as its watch mode: digits only (`-5`, `1e3` and `1.5` are no interval), within the poller's range.
function parsePoll(value: string): WatchMode | UsageError {
  if (!/^\d+$/u.test(value)) {
    return refuse("--poll needs an interval in milliseconds, such as --poll 200");
  }

  const mode = pollEvery(Number(value));

  return mode._tag === "PollIntervalOutOfRange"
    ? refuse(`--poll ${value}: the interval must be between ${MIN_POLL_MS} and ${MAX_POLL_MS} milliseconds`)
    : mode;
}

/**
 * The contract's syntax: the command, then each flag once, a flag's value as the next argument, and every argument one
 * whole token (no `--flag=value`, no `--` terminator, no `-abc` cluster). The line is read left to right and the first
 * syntax error wins. An invalid `--poll` value is judged where it is read, so it wins over an error in a later
 * argument. The rules between flags apply after the whole line is read.
 */
function parseArgs(args: ReadonlyArray<string>): CommandLine | UsageError {
  const [command, ...rest] = args;

  if (command !== "extract" && command !== "check") {
    return refuse(`unknown command: ${command ?? "(none)"}`);
  }

  let json = false;
  let watch = false;
  let config = CONFIG_FILE;
  let poll: WatchMode | undefined;
  // The flags given so far: a second of any is a repeat.
  const given = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    const value = rest[index + 1];

    if (given.has(arg)) {
      return refuse(`unexpected argument: ${arg}`);
    }

    given.add(arg);

    // Every command reads every flag, so that a flag used with the wrong command gets its own reason (`check --watch`),
    // not "unexpected argument". The booleans are presence-only: `--no-json`, `--json=…` and a following `false` are
    // arguments no case knows.
    switch (arg) {
      case "--json": {
        json = true;
        break;
      }
      case "--watch": {
        watch = true;
        break;
      }
      case "--config": {
        // `--config` takes the next argument unless that starts with `--`: `-x` is a path, `--draft.json` is not.
        if (value === undefined || value.startsWith("--")) {
          return refuse("--config needs a path");
        }

        config = value;
        index += 1;
        break;
      }
      case "--poll": {
        // `--poll` takes the next argument, or none at the end, as its value, whatever it reads like.
        const parsed = parsePoll(value ?? "");

        if (parsed._tag === "UsageError") {
          return parsed;
        }

        poll = parsed;
        index += 1;
        break;
      }
      default: {
        return refuse(`unexpected argument: ${arg}`);
      }
    }
  }

  if (watch && (command !== "extract" || json)) {
    return refuse(WATCH_WITHOUT_EXTRACT);
  }

  if (poll !== undefined && !watch) {
    return refuse(POLL_WITHOUT_WATCH);
  }

  return watch
    ? { _tag: "Watch", config, mode: poll ?? { _tag: "native" } }
    : { _tag: "Once", command, json, config };
}

/**
 * The `elmera-intl` program for `args`: parse them, apply the rules between flags, and run the command. A defect (an
 * exception the commands do not classify) stays a defect. A watch syncs through the `CatalogSync`, and listens through
 * the `FileEvents`, that the host provides for the whole program (`hostServices()` in the executable), so both outlive
 * the watch.
 *
 * @param args - The arguments after the program name.
 * @param options - The directory the default config path resolves in.
 * @returns An effect that writes the command's output and fails with `UsageError` (printed with the usage text) or
 *   `ProblemsFound` (printed by the command).
 */
export const cliProgram = /* @__PURE__ */ Effect.fn("elmera-intl")(
  function* (args: ReadonlyArray<string>, options: CliOptions) {
    const line = parseArgs(args);

    if (line._tag === "UsageError") {
      return yield* line;
    }

    const configPath = resolve(options.cwd, line.config);

    return line._tag === "Watch"
      ? yield* watchUntilSignal(configPath, line.mode)
      : yield* runOnce(line.command, line.json, configPath);
  },
  /* @__PURE__ */ Effect.tapErrorTag("UsageError", (error) =>
    Reporter.use((reporter) => reporter.stderr(`${error.reason}\n${USAGE}\n`))
  )
);

// The signals that stop the watch. On just before the watch starts (a one-shot command, or a config still being read,
// keeps Node's default and ends at once), so they are on before the first sync, and off again when the watch's scope
// closes, a failed start included. The first signal takes both off, so a second gets Node's default.
const signalListeners = (stop: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const off = () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
      const onSignal = () => {
        off();
        Deferred.doneUnsafe(stop, Effect.void);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      return off;
    }),
    (off) => Effect.sync(off)
  );

const watchUntilSignal = /* @__PURE__ */ Effect.fn("elmera-intl.watch")(function* (
  configPath: string,
  mode: WatchMode
) {
  const reporter = yield* Reporter;
  const first = yield* readConfigSnapshot(configPath);

  if (first.loaded._tag === "ConfigInvalid") {
    yield* printProblems([first.loaded.problem]);

    return yield* new ProblemsFound({ count: 1 });
  }

  // The root of the watch in force: the config's root is its directory's real path, which a link to the directory
  // repointed moves (the follow restarts on it), so each watch's writes are named from its own.
  let { root } = first.loaded.config;
  const stop = yield* Deferred.make<void>();
  yield* signalListeners(stop);
  // The watch writes every result, and the ready line after the first, in order, one at a time, so the Reporter may be
  // asynchronous; it follows each edit of the config, and each move of its root. Until a signal, or a write
  // that fails for good: then it closes its watchers, drains and ends as the writing did; a watcher that failed to close
  // is a crash, after every report. A start a signal stopped is no failure: the program ends as the watch's end does.
  // Its extract is the program's `CatalogSync`, which the host provides around the whole program, so it outlives the
  // watch's stop, an interruption's included.
  yield* followConfig(configPath, first, mode, stop, {
    starting: (config) => {
      ({ root } = config);
    },
    report: (result) => reportSync(configPath, root, result),
    ready: Effect.suspend(() => reporter.stdout(`watching ${root} for message changes; Ctrl-C stops\n`)),
  }).pipe(Effect.flatMap((watching) => watching.done));
}, Effect.scoped);

const reportSync = /* @__PURE__ */ Effect.fn("elmera-intl.watch.report")(function* (
  configPath: string,
  root: string,
  result: SyncResult
) {
  const reporter = yield* Reporter;

  if (result._tag === "Written") {
    yield* reporter.stdout(`wrote ${result.files.map((file) => relative(root, file)).join(", ")}\n`);
  } else if (result._tag === "Failed") {
    yield* printProblems(result.problems);
  } else if (result._tag === "ConfigChanged") {
    // The config's own name: its root is the real path of its directory, which another spelling of the path reaches.
    yield* reporter.stdout(`${basename(configPath)} changed, restarting the watch\n`);
  }
});

/**
 * The executable's program: the arguments from `Stdio`, the command's output on `io`, the project's services on Node,
 * the extract and Node's file events for a watch (`hostServices()`), provided once for the whole program, and a crash
 * printed.
 *
 * @param io - The process's working directory and output streams.
 * @returns The program to run as the process's main fiber; `exitCodeOf` reads its exit.
 */
export function executable(io: CliIo): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const args = yield* Stdio.Stdio.use((stdio) => stdio.args);
    yield* cliProgram(args, io);
  }).pipe(reportCrash, Effect.provide([CliPlatform, Reporter.layer(io), hostServices()]));
}

/**
 * The exit code of a finished run: 0 when clean (a watch a signal stopped included), 1 when it found problems, 2 on a
 * usage error or a crash.
 *
 * @param exit - How the program ended.
 * @returns The process exit code.
 */
export function exitCodeOf(exit: Exit.Exit<unknown, unknown>): number {
  if (Exit.isSuccess(exit)) {
    return 0;
  }

  // A defect is a crash, whatever code it carries: 2, never "problems found".
  if (Cause.hasDies(exit.cause)) {
    return 2;
  }

  const failure = Cause.squash(exit.cause);

  // Anything else without its own code is an interruption, which nothing in the CLI sends.
  return Predicate.hasProperty(failure, Runtime.errorExitCode) ? Runtime.getErrorExitCode(failure) : 2;
}

/**
 * The one platform service the executable needs that the project's services do not provide: Node's `Stdio`, the
 * process's arguments.
 */
export const CliPlatform: Layer.Layer<Stdio.Stdio> = NodeStdio.layer;
