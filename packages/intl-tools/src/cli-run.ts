// The `elmera-intl` executable's program: effect/cli parses the arguments into a command, a one-shot command runs
// through command-run.ts (which the hosts call directly), and a watch runs until a signal stops it.

import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as Cause from "effect/Cause";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliError from "effect/cli/CliError";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Context from "effect/Context";
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

import { printProblems, ProblemsFound, reportCrash, runOnce } from "./command-run";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { ReporterIo } from "./reporter";
import { Reporter } from "./reporter";
import type { PollIntervalOutOfRange, ProjectWatcher, SyncResult, WatchMode } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery, syncFailed, watchProject } from "./watch";

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

// `--poll` parses to its watch mode. Flag.Int would take `-5` and `1e3` as numbers, where the contract takes only
// digits; its filters' messages are the contract's reasons.
const POLL_FLAG = /* @__PURE__ */ Flag.String("poll").pipe(
  /* @__PURE__ */ Flag.filter(
    (value) => /^\d+$/u.test(value),
    () => "--poll needs an interval in milliseconds, such as --poll 200"
  ),
  /* @__PURE__ */ Flag.filterMap(
    (value) => Option.liftPredicate(pollEvery(Number(value)), isPolling),
    (value) => `--poll ${value}: the interval must be between ${MIN_POLL_MS} and ${MAX_POLL_MS} milliseconds`
  )
);

// The flags every command parses, so that a flag used with the wrong command gets its own reason (`check --watch`),
// not "unexpected argument". The booleans are presence-only, as the contract has them: `scanArgs` rejects
// `--no-json` and `--json=…`, and leaves a following `false` an argument, before effect/cli reads them.
const FLAGS = {
  json: /* @__PURE__ */ Flag.Boolean("json").pipe(/* @__PURE__ */ Flag.withDefault(false)),
  watch: /* @__PURE__ */ Flag.Boolean("watch").pipe(/* @__PURE__ */ Flag.withDefault(false)),
  config: /* @__PURE__ */ Flag.String("config").pipe(/* @__PURE__ */ Flag.withDefault(CONFIG_FILE)),
  poll: /* @__PURE__ */ POLL_FLAG.pipe(Flag.optional),
};

// What `scanArgs` accepts as a flag: exactly the names effect/cli declares, each once.
const FLAG_NAMES: ReadonlyArray<string> = /* @__PURE__ */ Object.keys(FLAGS).map((name) => `--${name}`);

function isPolling(mode: WatchMode | PollIntervalOutOfRange): mode is WatchMode {
  return mode._tag !== "PollIntervalOutOfRange";
}

/** The flags as effect/cli parses them, before the rules between flags apply. */
type ParsedFlags = Command.Command.Config.Infer<typeof FLAGS>;

/** The directory the program resolves the default config path in, provided with the grammar. */
class WorkingDirectory
  extends /* @__PURE__ */ Context.Service<WorkingDirectory, CliOptions>()(
    "elmera-intl-tools/WorkingDirectory"
  ) {}

const WATCH_WITHOUT_EXTRACT = "--watch goes with extract only, without --json";
const POLL_WITHOUT_WATCH = "--poll goes with extract --watch only";

const configPathOf = (config: string) => WorkingDirectory.useSync(({ cwd }) => resolve(cwd, config));

const extract = /* @__PURE__ */ Command.make(
  "extract",
  FLAGS,
  /* @__PURE__ */ Effect.fn("elmera-intl.extract")(function* (flags: ParsedFlags) {
    const configPath = yield* configPathOf(flags.config);

    if (!flags.watch) {
      return yield* runOnce("extract", flags.json, configPath);
    }

    return yield* watchUntilSignal(
      configPath,
      Option.getOrElse(flags.poll, (): WatchMode => ({ _tag: "native" }))
    );
  })
).pipe(
  /* @__PURE__ */ Command.validate((flags) => {
    if (flags.watch && flags.json) {
      return Effect.fail(new UsageError({ reason: WATCH_WITHOUT_EXTRACT }));
    }

    return Option.isSome(flags.poll) && !flags.watch
      ? Effect.fail(new UsageError({ reason: POLL_WITHOUT_WATCH }))
      : Effect.void;
  })
);

const check = /* @__PURE__ */ Command.make(
  "check",
  FLAGS,
  /* @__PURE__ */ Effect.fn("elmera-intl.check")(function* (flags: ParsedFlags) {
    return yield* runOnce("check", flags.json, yield* configPathOf(flags.config));
  })
).pipe(
  /* @__PURE__ */ Command.validate((flags) => {
    if (flags.watch) {
      return Effect.fail(new UsageError({ reason: WATCH_WITHOUT_EXTRACT }));
    }

    return Option.isSome(flags.poll)
      ? Effect.fail(new UsageError({ reason: POLL_WITHOUT_WATCH }))
      : Effect.void;
  })
);

// No --version: builtIns are off, so the version is never printed.
const runCommandLine = /* @__PURE__ */ Command.runWith(
  /* @__PURE__ */ Command.make("elmera-intl").pipe(/* @__PURE__ */ Command.withSubcommands([extract, check])),
  { version: "", renderErrors: false }
);

// The grammar's own settings, provided inside the parse so that no service a host provides can change them: no
// --help, --version, --wizard, --completions or --log-level (each would take a flag's place), and a silent presenter
// (the program prints its own usage errors, and effect/cli's help would go to the global console).
const grammar = /* @__PURE__ */ Layer.merge(
  /* @__PURE__ */ CliConfig.layer({ builtIns: [] }),
  /* @__PURE__ */ CliOutput.layerPresenter({ present: () => Effect.void })
);

// A scanned argument list fails to parse only on a `--poll` value, whose filters' messages are the contract's
// reasons; any other parse error means the scan and effect/cli disagree, a defect.
const pollReason = (error: CliError.CliError): Effect.Effect<never, UsageError> => {
  const poll = (error._tag === "ShowHelp" ? error.errors : [error]).find(
    (reason) => reason._tag === "InvalidValue" && reason.option === "poll"
  );

  return poll?._tag === "InvalidValue"
    ? Effect.fail(new UsageError({ reason: poll.expected }))
    : Effect.die(error);
};

type Scanned =
  | { readonly _tag: "Tokens"; readonly tokens: ReadonlyArray<string> }
  | {
      readonly _tag: "SyntaxError";
      /** The `--poll` value read before the error, which layer 1 judged first. */
      readonly poll: string | undefined;
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
    return { _tag: "SyntaxError", poll: undefined, reason: `unknown command: ${command ?? "(none)"}` };
  }

  const tokens: Array<string> = [command];
  let poll: string | undefined;
  // The flags not yet given: an argument that is none of them is unknown or a repeat.
  const remaining = new Set(FLAG_NAMES);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    const value = rest[index + 1];

    if (!remaining.delete(arg)) {
      return { _tag: "SyntaxError", poll, reason: `unexpected argument: ${arg}` };
    }

    if (arg === "--config") {
      // `--config` takes the next argument unless it is a flag.
      if (value === undefined || value.startsWith("--")) {
        return { _tag: "SyntaxError", poll, reason: "--config needs a path" };
      }

      tokens.push(`--config=${value}`);
      index += 1;
    } else if (arg === "--poll") {
      // `--poll` takes the next argument, or none at the end, as its value, which only its filters judge.
      poll = value ?? "";
      tokens.push(`--poll=${poll}`);
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
 * @param options - The directory the default config path resolves in.
 * @returns An effect that writes the command's output and fails with `UsageError` (printed with the usage text) or
 *   `ProblemsFound` (printed by the command).
 */
export const cliProgram = /* @__PURE__ */ Effect.fn("elmera-intl")(
  function* (args: ReadonlyArray<string>, options: CliOptions) {
    const scanned = scanArgs(args);

    if (scanned._tag === "Tokens") {
      return yield* runCommandLine(scanned.tokens).pipe(
        Effect.provideService(WorkingDirectory, options),
        Effect.provide(grammar),
        Effect.catchIf(CliError.isCliError, pollReason)
      );
    }

    // An invalid --poll value before the syntax error fails first, as layer 1 judged each value where it read it.
    if (scanned.poll !== undefined) {
      yield* POLL_FLAG.parse({ flags: { poll: [scanned.poll] }, arguments: [] }).pipe(
        Effect.catchIf(CliError.isCliError, pollReason)
      );
    }

    return yield* new UsageError({ reason: scanned.reason });
  },
  /* @__PURE__ */ Effect.tapErrorTag("UsageError", (error) =>
    Reporter.use((reporter) => reporter.stderr(`${error.reason}\n${USAGE}\n`))
  )
);

// The watch lifts its still-synchronous config read and watcher into the program, until the watch layer makes them
// effects; an exception is a defect, as before.
const watchConfig = (configPath: string) => Effect.sync(() => loadConfig(configPath));
// The watcher and the signals that stop it. The listeners go on just before the watcher starts (a one-shot command, or
// a config still being read, keeps Node's default and ends at once), so they are on before the first sync, and come off
// again if the watcher fails to start. The first signal takes both off (a second gets Node's default), closes the
// watcher, so no new sync starts, and ends the results: a sync already running finishes, as it cannot be cut short, and
// every delivered result is still reported. The close's outcome is held before the results end, since ending them
// resumes the reporting fiber at once, so the watcher closes once and a failed close is not lost.
const startWatcher = (config: ProjectConfig, mode: WatchMode, results: Queue.Queue<SyncResult, Cause.Done>) =>
  Effect.sync(() => {
    let watcher: ProjectWatcher | undefined;
    let closed: Promise<Exit.Exit<void>> | undefined;
    const offSignals = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    // Idempotent: the first signal, and the scope on any exit, both stop the watch.
    const stop = (): Promise<Exit.Exit<void>> => {
      if (closed === undefined) {
        offSignals();
        // A close that throws fails as one that rejects does, and the results still end.
        closed = Promise.try(() => watcher?.close()).then(() => Exit.void, Exit.die);
        Queue.endUnsafe(results);
      }

      return closed;
    };
    const onSignal = () => {
      void stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      watcher = watchProject(
        config,
        (result) => {
          Queue.offerUnsafe(results, result);
        },
        undefined,
        mode
      );
    } catch (error) {
      offSignals();
      throw error;
    }

    return { stop };
  });

const watchUntilSignal = /* @__PURE__ */ Effect.fn("elmera-intl.watch")(function* (
  configPath: string,
  mode: WatchMode
) {
  const reporter = yield* Reporter;
  const loaded = yield* watchConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    yield* printProblems([loaded.problem]);

    return yield* new ProblemsFound({ count: 1 });
  }

  const { config } = loaded;
  // The watcher calls back from outside this fiber; this fiber reports each result, so the Reporter may be
  // asynchronous.
  const results = yield* Queue.unbounded<SyncResult, Cause.Done>();
  // After the last report, the close's outcome: a failed close is a crash, as it always was.
  yield* Effect.acquireRelease(startWatcher(config, mode, results), (started) =>
    Effect.promise(() => started.stop()).pipe(Effect.flatten)
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
    yield* printProblems(result.problems);
  }
});

/**
 * The executable's program: the arguments from `Stdio`, the command's output on `io`, and a crash printed.
 *
 * @param io - The process's working directory and output streams.
 * @returns The program to run as the process's main fiber; `exitCodeOf` reads its exit.
 */
export function executable(io: CliIo): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const args = yield* Stdio.Stdio.use((stdio) => stdio.args);
    yield* cliProgram(args, io);
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

  // A defect is a crash, whatever code it carries (effect/cli's ShowHelp carries 1, or 0): 2, never "problems found".
  if (Cause.hasDies(exit.cause)) {
    return 2;
  }

  const failure = Cause.squash(exit.cause);

  // Anything else without its own code is an interruption, which nothing in the CLI sends.
  return Predicate.hasProperty(failure, Runtime.errorExitCode) ? Runtime.getErrorExitCode(failure) : 2;
}

// A service the CLI does not use: its flags read no file, it prompts for nothing and spawns nothing. The layer that
// first uses one provides its Node implementation instead (@effect/platform-node-shared).
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
