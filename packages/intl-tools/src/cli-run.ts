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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { relative, resolve } from "node:path";
import process from "node:process";

import type { CommandReport } from "./commands";
import { runCheck, runExtract } from "./commands";
import { describeProblem } from "./problem";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { ReporterIo } from "./reporter";
import { Reporter } from "./reporter";
import type { PollIntervalOutOfRange, SyncResult, WatchMode } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery, syncFailed, watchProject } from "./watch";

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
// not "unexpected argument". The booleans are presence-only, as the contract has them: no `--no-json`, and a value
// never attaches (`--json false` leaves `false` an argument). `--poll` parses to its watch mode; Flag.Int would take
// `-5` and `1e3` as numbers, where the contract takes only digits.
const flags = () => ({
  json: Flag.Boolean("json").pipe(
    Flag.withoutNegation,
    Flag.withOptionalValue("true"),
    Flag.withDefault(false)
  ),
  watch: Flag.Boolean("watch").pipe(
    Flag.withoutNegation,
    Flag.withOptionalValue("true"),
    Flag.withDefault(false)
  ),
  config: Flag.String("config").pipe(Flag.optional),
  poll: Flag.String("poll").pipe(
    Flag.filter(
      (value) => /^\d+$/u.test(value),
      () => "--poll needs an interval in milliseconds, such as --poll 200"
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

// The grammar's own settings, provided inside the parse so that no service a host provides can change them: no
// --help, --version, --wizard, --completions or --log-level (each would take a flag's place), and a silent presenter
// (the program prints its own usage errors, and effect/cli's help would go to the global console).
const grammar = /* @__PURE__ */ Layer.merge(
  /* @__PURE__ */ CliConfig.layer({ builtIns: [] }),
  /* @__PURE__ */ CliOutput.layerPresenter({ present: () => Effect.void })
);

/**
 * Parse scanned tokens with effect/cli and run what they name. A scanned argument list fails to parse only on a
 * `--poll` value, whose filters' messages are the contract's reasons; any other parse error means the scan and
 * effect/cli disagree, a defect.
 */
function parse<E, R>(
  tokens: ReadonlyArray<string>,
  run: (invocation: Invocation) => Effect.Effect<void, E, R>
): Effect.Effect<void, E | UsageError, R | Command.Environment> {
  const tree = Command.make("elmera-intl").pipe(
    Command.withSubcommands([
      Command.make("extract", flags(), (input) => run({ command: "extract", ...input })),
      Command.make("check", flags(), (input) => run({ command: "check", ...input })),
    ])
  );

  // No --version: builtIns are off, so the version is never printed.
  return Command.runWith(tree, { version: "", renderErrors: false })(tokens).pipe(
    Effect.provide(grammar),
    Effect.catchIf(CliError.isCliError, (error) => {
      const poll = (error._tag === "ShowHelp" ? error.errors : [error]).find(
        (reason) => reason._tag === "InvalidValue" && reason.option === "poll"
      );

      return poll?._tag === "InvalidValue"
        ? Effect.fail(new UsageError({ reason: poll.expected }))
        : Effect.die(error);
    })
  );
}

type Scanned =
  | { readonly _tag: "Tokens"; readonly tokens: ReadonlyArray<string> }
  | {
      readonly _tag: "SyntaxError";
      /** The complete options before the error, as `Tokens` passes them; empty when the command is the error. */
      readonly tokens: ReadonlyArray<string>;
      readonly reason: string;
    };

/**
 * The contract's syntax, read left to right as layer 1's parser read it: the command, then each flag once, a flag's
 * value as the next argument, and every argument one whole token. effect/cli's lexer reads `--flag=value`, `--` and
 * `-abc` differently and reports flags before arguments, so the scan finds the first syntax error itself. It passes
 * each value joined to its flag (`--config=-x`), so a value that looks like a flag stays the value it is.
 */
function scanArgs(args: ReadonlyArray<string>): Scanned {
  const [command, ...rest] = args;

  if (command !== "extract" && command !== "check") {
    return { _tag: "SyntaxError", tokens: [], reason: `unknown command: ${command ?? "(none)"}` };
  }

  const tokens: Array<string> = [command];
  // The flags not yet given, named from their definitions: an argument that is none of them is unknown or a repeat.
  const remaining = new Set(Object.keys(flags()).map((name) => `--${name}`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    const value = rest[index + 1];

    if (!remaining.delete(arg)) {
      return { _tag: "SyntaxError", tokens, reason: `unexpected argument: ${arg}` };
    }

    if (arg === "--config") {
      // `--config` takes the next argument unless it is a flag.
      if (value === undefined || value.startsWith("--")) {
        return { _tag: "SyntaxError", tokens, reason: "--config needs a path" };
      }

      tokens.push(`--config=${value}`);
      index += 1;
    } else if (arg === "--poll") {
      // `--poll` takes the next argument, or none at the end, as its value, which only its filters judge.
      tokens.push(`--poll=${value ?? ""}`);
      index += 1;
    } else {
      tokens.push(arg);
    }
  }

  return { _tag: "Tokens", tokens };
}

/**
 * The `elmera-intl` program for `args`: parse them, apply the rules between flags, and run the command. A defect (an
 * exception the commands do not classify) stays a defect.
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
    const scanned = scanArgs(args);

    if (scanned._tag === "Tokens") {
      return yield* parse(scanned.tokens, (invocation) => dispatch(invocation, options));
    }

    // An invalid --poll value before the syntax error fails first, as layer 1 judged each value where it read it.
    if (scanned.tokens.length > 0) {
      yield* parse(scanned.tokens, () => Effect.void);
    }

    return yield* new UsageError({ reason: scanned.reason });
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

// The commands are still synchronous. These are the one place each is lifted into the program (a one-shot report;
// the watch's config read and its watcher), until the commands and watch layers make them effects; an exception is a
// defect, as before.
const commandReport = (command: "extract" | "check", configPath: string) =>
  Effect.sync((): CommandReport => {
    const loaded = loadConfig(configPath);

    if (loaded._tag === "ConfigInvalid") {
      return { problems: [loaded.problem], messages: 0, written: [], unreachable: [] };
    }

    return command === "extract" ? runExtract(loaded.config) : runCheck(loaded.config);
  });
const watchConfig = (configPath: string) => Effect.sync(() => loadConfig(configPath));
// The watcher and the signals that stop it. The listeners go on just before the watcher starts (a one-shot command, or
// a config still being read, keeps Node's default and ends at once), so they are on before the ready line. The first
// signal takes both off (a second gets Node's default), closes the watcher, so no new sync starts, and ends the
// results: a sync already running finishes, as it cannot be cut short, and every delivered result is still reported.
const startWatcher = (config: ProjectConfig, mode: WatchMode, results: Queue.Queue<SyncResult, Cause.Done>) =>
  Effect.sync(() => {
    let closed: Promise<void> | undefined;
    // Idempotent: the first signal, and the scope on any other exit, both stop the watch.
    const stop = (): Promise<void> => {
      if (closed === undefined) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        Queue.endUnsafe(results);
        closed = watcher.close();
      }

      return closed;
    };
    const onSignal = () => {
      void stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const watcher = watchProject(
      config,
      (result) => {
        Queue.offerUnsafe(results, result);
      },
      undefined,
      mode
    );

    return { stop };
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
  const loaded = yield* watchConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    yield* reporter.stderr(`${describeProblem(loaded.problem)}\n`);

    return yield* new ProblemsFound({ count: 1 });
  }

  const { config } = loaded;
  // The watcher calls back from outside this fiber; this fiber reports each result, so the Reporter may be
  // asynchronous.
  const results = yield* Queue.unbounded<SyncResult, Cause.Done>();
  const watch = yield* Effect.acquireRelease(startWatcher(config, mode, results), (started) =>
    Effect.promise(() => started.stop())
  );
  // The first sync runs as the watcher starts: its report precedes the ready line.
  yield* Effect.forEach(yield* Queue.clear(results), (result) => reportResult(config.root, result), {
    discard: true,
  });
  yield* reporter.stdout(`watching ${config.root} for message changes; Ctrl-C stops\n`);
  // Until a signal ends the results, and then through every result already delivered.
  yield* Queue.take(results).pipe(
    Effect.flatMap((result) => reportResult(config.root, result)),
    Effect.forever,
    Effect.catchIf(Cause.isDone, () => Effect.void)
  );
  yield* Effect.promise(() => watch.stop());
}, Effect.scoped);

// One result's report. A write that fails is reported as the sync's failure, `SyncFailed`, and the watch goes on, as a
// throwing report always was; if that report fails too, the failure ends the watch.
const reportResult = (root: string, result: SyncResult) =>
  reportSync(root, result).pipe(
    Effect.catchDefect((defect) =>
      reportSync(root, syncFailed(defect instanceof Error ? defect.message : String(defect)))
    )
  );

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
  )
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
