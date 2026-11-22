// The `elmera-intl` program: effect/cli parses the arguments into a command, and the command writes its report through
// Reporter. The executable (cli.ts) and the hosts (the Vite build check, the Vitest setup) run this one program, so they
// print, and exit, alike.

import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as Cause from "effect/Cause";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliError from "effect/cli/CliError";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { relative, resolve } from "node:path";
import process from "node:process";

import type { CommandReport } from "./commands";
import { runCheck, runExtract } from "./commands";
import { describeProblem } from "./problem";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { ReporterIo } from "./reporter";
import { Reporter } from "./reporter";
import type { PollIntervalOutOfRange, SyncResult, WatchMode } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery, watchProject } from "./watch";

/** Where the CLI writes and resolves paths from. */
export type CliIo = ReporterIo & {
  /** Directory the default config path is resolved in. */
  readonly cwd: string;
};

/**
 * Who runs the program. Only the executable owns the process's signals, which end a watch; a host running the CLI
 * in-process gets a usage error for `--watch`.
 */
export type CliHost = "executable" | "in-process";

const USAGE = `usage: elmera-intl <extract|check> [--json] [--config <path to ${CONFIG_FILE}>]
       elmera-intl extract --watch [--poll <ms>] [--config <path to ${CONFIG_FILE}>]`;
const POLL_NEEDS_INTERVAL = "--poll needs an interval in milliseconds, such as --poll 200";

/** Arguments the CLI refuses, with the reason it prints above the usage text. Exit code 2. */
export class UsageError
  extends /* @__PURE__ */ Schema.TaggedError<UsageError>()("UsageError", { reason: Schema.String })
{
  /** Usage errors exit 2, apart from 1, "problems found". */
  override readonly [Runtime.errorExitCode] = 2;
}

/** The command ran and reported problems, already printed. Exit code 1. */
export class ProblemsFound
  extends /* @__PURE__ */ Schema.TaggedError<ProblemsFound>()("ProblemsFound", {
    count: Schema.Finite,
  })
{
  /** Problems found exit 1. */
  override readonly [Runtime.errorExitCode] = 1;
}

/** The program died (a defect, or I/O the commands do not classify), its stack already printed. Exit code 2. */
export class CliCrashed extends /* @__PURE__ */ Schema.TaggedError<CliCrashed>()("CliCrashed", {}) {
  /** A crash exits 2, never 1, so it cannot read as "problems found". */
  override readonly [Runtime.errorExitCode] = 2;
}

/** Every way the program fails, each carrying its exit code. */
export type CliFailure = UsageError | ProblemsFound;

// The flags every command parses, so that a flag used with the wrong command gets its own reason (`check --watch`),
// not "unexpected argument". `--poll` parses to its watch mode; Flag.Int would take `-5` and `1e3` as numbers, where
// the contract takes only digits.
const flags = () => ({
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  watch: Flag.Boolean("watch").pipe(Flag.withDefault(false)),
  config: Flag.String("config").pipe(Flag.optional),
  poll: Flag.String("poll").pipe(
    Flag.filter(
      (value) => /^\d+$/u.test(value),
      () => POLL_NEEDS_INTERVAL
    ),
    Flag.filterMap(
      (value) => Option.liftPredicate(pollEvery(Number(value)), isPolling),
      (value) =>
        `--poll ${value}: the interval must be between ${MIN_POLL_MS} and ${MAX_POLL_MS} milliseconds`
    ),
    Flag.optional
  ),
});

function isPolling(mode: WatchMode | PollIntervalOutOfRange): mode is WatchMode {
  return mode._tag !== "PollIntervalOutOfRange";
}

/** One parsed invocation: a command and its flags, before the rules between flags apply. */
type Invocation = {
  readonly command: "extract" | "check";
  readonly json: boolean;
  readonly watch: boolean;
  readonly config: Option.Option<string>;
  readonly poll: Option.Option<WatchMode>;
};

// The command tree, built around what runs once the arguments parse: finding the first failing argument parses with
// a handler that does nothing.
function commandTree<E, R>(run: (invocation: Invocation) => Effect.Effect<void, E, R>) {
  return Command.make("elmera-intl").pipe(
    Command.withSubcommands([
      Command.make("extract", flags(), (input) => run({ command: "extract", ...input })),
      Command.make("check", flags(), (input) => run({ command: "check", ...input })),
    ])
  );
}

function parse<E, R>(
  tokens: ReadonlyArray<string>,
  run: (invocation: Invocation) => Effect.Effect<void, E, R>
): Effect.Effect<void, E | CliError.CliError, R | Command.Environment> {
  // No --version: builtIns are off, so the version is never printed.
  return Command.runWith(commandTree(run), { version: "", renderErrors: false })(tokens);
}

/**
 * The contract reports the first argument that fails, reading left to right, where effect/cli reports flags before
 * arguments. Each flag's value is joined to it (`guardArgs`), so every token is one argument, and the first failing
 * token is the end of the shortest prefix that fails to parse.
 */
const firstFailure = /* @__PURE__ */ Effect.fn("elmera-intl.firstFailure")(function* (
  tokens: ReadonlyArray<string>,
  otherwise: UsageError
) {
  for (let end = 1; end <= tokens.length; end += 1) {
    const failure = yield* parse(tokens.slice(0, end), () => Effect.void).pipe(
      Effect.match({ onFailure: (error): CliError.CliError | undefined => error, onSuccess: () => undefined })
    );

    if (failure !== undefined) {
      return yield* new UsageError({ reason: reasonOf(failure) });
    }
  }

  return yield* otherwise;
});

// Each effect/cli parse error as today's reason. The flag names in `option` carry no dashes.
function reasonOf(error: CliError.CliError): string {
  switch (error._tag) {
    case "ShowHelp": {
      // The contract rejects a repeated flag before it reads the repeat's value.
      const [first] = error.errors.toSorted((a, b) => Number(isRepeat(b)) - Number(isRepeat(a)));

      // A bare `elmera-intl` asks for help, with no error of its own.
      return first === undefined ? "unknown command: (none)" : reasonOf(first);
    }
    case "UnknownSubcommand":
      return `unknown command: ${error.subcommand}`;
    case "UnrecognizedOption":
      // A flag before the command stands where the command goes.
      return error.command?.length === 1
        ? `unknown command: ${error.option}`
        : `unexpected argument: ${error.option}`;
    case "UnexpectedArgument":
      return `unexpected argument: ${error.arguments[0] ?? ""}`;
    case "DuplicateOption":
      return `unexpected argument: --${error.option}`;
    case "MissingOption":
    case "InvalidValue":
      return reasonForFlag(error);
    default:
      return error.message;
  }
}

// effect/cli reports a flag given twice as an invalid value counting its occurrences.
function isRepeat(error: CliError.CliError): boolean {
  return error._tag === "InvalidValue" && error.value.endsWith(" occurrences");
}

function reasonForFlag(error: CliError.MissingOption | CliError.InvalidValue): string {
  if (isRepeat(error)) {
    return `unexpected argument: --${error.option}`;
  }

  if (error.option === "config") {
    return "--config needs a path";
  }

  // The guard always gives --poll a value, so its errors are its filters' own messages: the contract's reasons.
  if (error.option === "poll" && error._tag === "InvalidValue") {
    return error.expected;
  }

  return error.message;
}

type GuardedArgs =
  | { readonly _tag: "Tokens"; readonly tokens: ReadonlyArray<string> }
  | {
      readonly _tag: "Rejected";
      /** The arguments before the rejected one, as `Tokens` passes them. */
      readonly prefix: ReadonlyArray<string>;
      readonly index: number;
      readonly token: string;
    };

/**
 * The contract reads every argument as one whole token, and a flag's value as the next argument. effect/cli's lexer
 * reads three kinds differently: `--flag=value` (a flag with its value), `--` (the end of the flags) and `-abc` (three
 * short flags). The guard finds the first such argument in a flag's place, which the CLI rejects, and passes every
 * flag value joined to its flag (`--config=-x`), so a value that looks like a flag stays the value it is today.
 */
function guardArgs(args: ReadonlyArray<string>): GuardedArgs {
  const tokens: Array<string> = [];
  let configs = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = args[index + 1];

    // As today: `--poll` takes the next argument, or none at the end, as its value, which only its filters judge;
    // `--config` takes the next argument unless it is a flag, and effect/cli reports one missing. A repeated
    // `--config` is rejected before its value is read, so it goes on as a bare repeat.
    if (index > 0 && arg === "--poll") {
      tokens.push(`--poll=${value ?? ""}`);
      index += 1;
    } else if (index > 0 && arg === "--config") {
      configs += 1;

      if (configs > 1) {
        tokens.push("--config=");
      } else if (value !== undefined && !value.startsWith("--")) {
        tokens.push(`--config=${value}`);
        index += 1;
      } else {
        tokens.push(arg);
      }
    } else if (readsDifferently(arg)) {
      return { _tag: "Rejected", prefix: tokens, index, token: arg };
    } else {
      tokens.push(arg);
    }
  }

  return { _tag: "Tokens", tokens };
}

function readsDifferently(arg: string): boolean {
  return (
    arg === "--" ||
    (arg.startsWith("--") && arg.includes("=")) ||
    (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1 && !NEGATIVE_NUMBER.test(arg))
  );
}

// effect/cli's lexer reads these as a value, not a short flag.
const NEGATIVE_NUMBER = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * The `elmera-intl` program for `args`: parse them, apply the rules between flags, and run the command.
 *
 * Its one interruptible step is the watch's wait, which runs until interrupted; `executable` runs everything else
 * uninterruptibly. A defect (an exception the commands do not classify) stays a defect.
 *
 * @param args - The arguments after the program name.
 * @param options - The directory the default config path resolves in, and who runs the program.
 * @returns An effect that writes the command's output and fails with `UsageError` (printed with the usage text) or
 *   `ProblemsFound` (printed by the command).
 */
export function cliProgram(
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly host: CliHost }
): Effect.Effect<void, CliFailure, Reporter | Command.Environment> {
  return Effect.gen(function* () {
    const guarded = guardArgs(args);

    if (guarded._tag === "Tokens") {
      return yield* parse(guarded.tokens, (invocation) => dispatch(invocation, options)).pipe(
        Effect.catchIf(CliError.isCliError, (error) =>
          firstFailure(guarded.tokens, new UsageError({ reason: reasonOf(error) }))
        )
      );
    }

    // An argument before the rejected one may fail first.
    return yield* firstFailure(
      guarded.prefix,
      new UsageError({
        reason:
          guarded.index === 0 ? `unknown command: ${guarded.token}` : `unexpected argument: ${guarded.token}`,
      })
    );
  }).pipe(
    Effect.tapErrorTag("UsageError", (error) =>
      Reporter.use((reporter) => reporter.stderr(`${error.reason}\n${USAGE}\n`))
    ),
    Effect.withSpan("elmera-intl")
  );
}

const dispatch = /* @__PURE__ */ Effect.fn("elmera-intl.dispatch")(function* (
  invocation: Invocation,
  options: { readonly cwd: string; readonly host: CliHost }
) {
  if (invocation.watch && (invocation.command !== "extract" || invocation.json)) {
    return yield* new UsageError({ reason: "--watch goes with extract only, without --json" });
  }

  if (Option.isSome(invocation.poll) && !invocation.watch) {
    return yield* new UsageError({ reason: "--poll goes with extract --watch only" });
  }

  const configPath = resolve(
    options.cwd,
    Option.getOrElse(invocation.config, () => CONFIG_FILE)
  );

  if (!invocation.watch) {
    return yield* runOnce(invocation.command, invocation.json, configPath);
  }

  if (options.host === "in-process") {
    return yield* new UsageError({
      reason: "--watch runs only from the elmera-intl executable, which owns the process's signals",
    });
  }

  return yield* watchUntilSignal(
    configPath,
    Option.getOrElse(invocation.poll, (): WatchMode => ({ _tag: "native" }))
  );
});

// The commands are still synchronous. These two are the one place each is lifted into the program, until the commands
// and watch layers make them effects; an exception is a defect, as before.
const commandReport = (command: "extract" | "check", configPath: string) =>
  Effect.sync((): CommandReport => {
    const loaded = loadConfig(configPath);

    if (loaded._tag === "ConfigInvalid") {
      return { problems: [loaded.problem], messages: 0, written: [], unreachable: [] };
    }

    return command === "extract" ? runExtract(loaded.config) : runCheck(loaded.config);
  });
const startWatch = (
  configPath: string,
  mode: WatchMode,
  onResult: (root: string, result: SyncResult) => void
) =>
  Effect.sync(() => {
    const loaded = loadConfig(configPath);

    return loaded._tag === "ConfigInvalid"
      ? loaded
      : {
          ...loaded,
          watcher: watchProject(
            loaded.config,
            (result) => onResult(loaded.config.root, result),
            undefined,
            mode
          ),
        };
  });

const runOnce = /* @__PURE__ */ Effect.fn("elmera-intl.once")(function* (
  command: "extract" | "check",
  json: boolean,
  configPath: string
) {
  const reporter = yield* Reporter;
  const report = yield* commandReport(command, configPath);

  if (json) {
    // stdout carries only the JSON document, so tooling can parse it.
    yield* reporter.stdout(renderJsonReport(report));
  } else {
    yield* Effect.forEach(report.problems, (problem) => reporter.stderr(`${describeProblem(problem)}\n`), {
      discard: true,
    });
    yield* reporter.stdout(
      command === "extract"
        ? `${report.messages} messages; wrote ${report.written.length} file(s)\n`
        : `${report.messages} messages; ${report.problems.length} problem(s)\n`
    );
  }

  if (report.problems.length > 0) {
    return yield* new ProblemsFound({ count: report.problems.length });
  }
});

function renderJsonReport(report: CommandReport): string {
  return `${JSON.stringify({ ok: report.problems.length === 0, ...report }, null, 2)}\n`;
}

const watchUntilSignal = /* @__PURE__ */ Effect.fn("elmera-intl.watch")(function* (
  configPath: string,
  mode: WatchMode
) {
  const reporter = yield* Reporter;
  // Only a watch owns SIGINT and SIGTERM, and only while it runs: a one-shot command keeps Node's default, which ends
  // it at once. On before the watcher starts, so a signal sent on seeing the ready line finds them; the first signal
  // stops the watch, and the scope closes the watcher.
  const stop = yield* Deferred.make<void>();
  const onSignal = () => {
    Deferred.doneUnsafe(stop, Effect.void);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }),
    () =>
      Effect.sync(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      })
  );

  // The watcher reports from its own callbacks, outside this fiber: each report runs on the program's services.
  const report = Effect.runSyncWith(yield* Effect.context<Reporter>());
  const started = yield* Effect.acquireRelease(
    startWatch(configPath, mode, (root, result) => {
      report(reportSync(root, result));
    }),
    (watch) => (watch._tag === "Config" ? Effect.promise(() => watch.watcher.close()) : Effect.void)
  );

  if (started._tag === "ConfigInvalid") {
    yield* reporter.stderr(`${describeProblem(started.problem)}\n`);

    return yield* new ProblemsFound({ count: 1 });
  }

  yield* reporter.stdout(`watching ${started.config.root} for message changes; Ctrl-C stops\n`);

  return yield* Deferred.await(stop);
}, Effect.scoped);

const reportSync = /* @__PURE__ */ Effect.fn("elmera-intl.watch.report")(function* (
  root: string,
  result: SyncResult
) {
  const reporter = yield* Reporter;

  if (result._tag === "Written") {
    yield* reporter.stdout(`wrote ${result.files.map((file) => relative(root, file)).join(", ")}\n`);
  } else if (result._tag === "Failed") {
    yield* Effect.forEach(result.problems, (problem) => reporter.stderr(`${describeProblem(problem)}\n`), {
      discard: true,
    });
  }
});

// A defect printed as `elmera-intl failed: ` and the thrown Error's own stack, then `CliCrashed`, so it exits 2 and never
// reads as exit 1 ("problems found").
function reportCrash<E, R>(
  program: Effect.Effect<void, E, R>
): Effect.Effect<void, E | CliCrashed, R | Reporter> {
  return program.pipe(
    Effect.catchDefect((defect) =>
      Reporter.use((reporter) =>
        reporter.stderr(
          `elmera-intl failed: ${defect instanceof Error ? (defect.stack ?? defect.message) : String(defect)}\n`
        )
      ).pipe(Effect.andThen(Effect.fail(new CliCrashed())))
    )
  );
}

/**
 * The executable's program: the arguments from `Stdio`, the command's output on `io`, and a crash printed.
 *
 * @param io - The process's working directory and output streams.
 * @returns The program to run as the process's main fiber; `exitCodeOf` reads its exit.
 */
export function executable(io: CliIo): Effect.Effect<void, CliFailure | CliCrashed> {
  return Effect.gen(function* () {
    const args = yield* Stdio.Stdio.use((stdio) => stdio.args);
    yield* cliProgram(args, { cwd: io.cwd, host: "executable" });
  }).pipe(reportCrash, Effect.provide(Layer.merge(CliPlatform, Reporter.layer(io))));
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

  const failure = Cause.squash(exit.cause);

  // Anything without its own code is a defect no one printed, or an interruption, which nothing in the CLI sends.
  return Predicate.hasProperty(failure, Runtime.errorExitCode) ? Runtime.getErrorExitCode(failure) : 2;
}

// What effect/cli requires of every program (`Command.Environment`) but the CLI does not use: its flags read no file,
// it prompts for nothing and spawns nothing. Each fails as a defect if reached; the layer that first uses a service
// provides its Node implementation instead (@effect/platform-node-shared).
const unused = (service: string) => Effect.die(`elmera-intl uses no ${service}`);

/**
 * The services effect/cli requires of every program (`Command.Environment`): Node's `Stdio` (the process's arguments)
 * and `Path`, and the services the CLI does not use, each a defect if reached.
 */
export const CliPlatform: Layer.Layer<Command.Environment> = /* @__PURE__ */ Layer.mergeAll(
  NodeStdio.layer,
  /* @__PURE__ */ FileSystem.layerNoop({}),
  NodePath.layer,
  /* @__PURE__ */ Layer.succeed(
    Terminal.Terminal,
    /* @__PURE__ */ Terminal.make({
      columns: /* @__PURE__ */ unused("terminal"),
      rows: /* @__PURE__ */ unused("terminal"),
      size: /* @__PURE__ */ unused("terminal"),
      readInput: /* @__PURE__ */ unused("terminal"),
      readLine: /* @__PURE__ */ unused("terminal"),
      display: () => unused("terminal"),
    })
  ),
  /* @__PURE__ */ Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    /* @__PURE__ */ ChildProcessSpawner.make(() => unused("child process"))
  ),
  // No --help, --version, --wizard, --completions or --log-level: the CLI has none, and each would take a flag's place.
  /* @__PURE__ */ CliConfig.layer({ builtIns: [] }),
  // Silent: the program prints its own usage errors (UsageError), and effect/cli's help would go to stdout.
  /* @__PURE__ */ CliOutput.layerPresenter({ present: () => Effect.void })
);

function inProcess<E>(io: CliIo, program: Effect.Effect<void, E, Reporter | Command.Environment>) {
  return Effect.runPromiseExit(program.pipe(Effect.provide(Layer.merge(CliPlatform, Reporter.layer(io)))));
}

/**
 * Run `elmera-intl extract | check [--json] [--config <path>]` in-process, for a host that reports a crash its own way.
 *
 * @param args - The arguments after the program name.
 * @param io - Working directory and output streams.
 * @returns The exit code: 0 when clean, 1 on any problem, 2 on a usage error; rejects with the thrown Error when a
 *   command throws.
 */
export async function runCli(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const exit = await inProcess(io, cliProgram(args, { cwd: io.cwd, host: "in-process" }));

  if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
    throw Cause.squash(exit.cause);
  }

  return exitCodeOf(exit);
}

/**
 * Run the CLI in-process, turning an unexpected exception (a defect, or I/O the CLI does not classify) into exit code 2
 * with the stack on stderr, so it never reads as exit 1 ("problems found").
 *
 * @param args - The arguments after the program name.
 * @param io - Working directory and output streams.
 * @returns The CLI's exit code, or 2 when it threw.
 */
export async function runGuarded(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  return exitCodeOf(await inProcess(io, reportCrash(cliProgram(args, { cwd: io.cwd, host: "in-process" }))));
}
