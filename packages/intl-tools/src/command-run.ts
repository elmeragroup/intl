// One `extract` or `check` run and its report, with no argument parsing: the CLI (cli-run.ts) runs it for a parsed
// command line, and the hosts (the Vite build check, the Vitest setup) call it directly, so they print, and exit,
// alike without loading effect/cli.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import type { CommandReport } from "./commands";
import { runCheck, runExtract } from "./commands";
import type { Problem } from "./problem";
import { describeProblem } from "./problem";
import { loadConfig } from "./project-config";
import type { ReporterIo } from "./reporter";
import { Reporter } from "./reporter";

/** The command ran and reported problems, already printed. Exit code 1. */
export class ProblemsFound
  extends /* @__PURE__ */ Schema.TaggedError<ProblemsFound>()("ProblemsFound", {
    count: Schema.Finite,
  })
{
  /** Problems found exit 1. */
  override readonly [Runtime.errorExitCode] = 1;
}

/** A one-shot command. */
export type OneShotCommand = "extract" | "check";

// The commands are still synchronous. This is the one place each is lifted into a program, until the commands layer
// makes them effects; an exception is a defect, as before.
const commandReport = (command: OneShotCommand, configPath: string) =>
  Effect.sync((): CommandReport => {
    const loaded = loadConfig(configPath);

    if (loaded._tag === "ConfigInvalid") {
      return { problems: [loaded.problem], messages: 0, written: [], unreachable: [] };
    }

    return command === "extract" ? runExtract(loaded.config) : runCheck(loaded.config);
  });

/**
 * Write each problem as its own line on the Reporter's stderr.
 *
 * @param problems - The problems to print, in order.
 * @returns An effect that writes them.
 */
export const printProblems = (problems: ReadonlyArray<Problem>): Effect.Effect<void, never, Reporter> =>
  Reporter.use((reporter) =>
    Effect.forEach(problems, (problem) => reporter.stderr(`${describeProblem(problem)}\n`), { discard: true })
  );

/**
 * Run `command` once on the config at `configPath` and report it: the problems on stderr and a summary line on
 * stdout, or with `json` only the JSON document on stdout.
 *
 * @param command - The command to run.
 * @param json - Whether stdout carries the JSON document instead of the summary line.
 * @param configPath - The absolute path of the project's `elmera-intl.json`.
 * @returns An effect that writes the report and fails with `ProblemsFound` when there were problems.
 */
export const runOnce = /* @__PURE__ */ Effect.fn("elmera-intl.once")(function* (
  command: OneShotCommand,
  json: boolean,
  configPath: string
) {
  const reporter = yield* Reporter;
  const report = yield* commandReport(command, configPath);

  if (json) {
    // stdout carries only the JSON document, so tooling can parse it.
    yield* reporter.stdout(renderJsonReport(report));
  } else {
    yield* printProblems(report.problems);
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

/**
 * Print a defect as `elmera-intl failed: ` and the thrown Error's own stack. It stays a defect, which the
 * executable reads as exit 2.
 *
 * @template E - The program's failures.
 * @template R - The program's requirements.
 * @param program - The program whose defect to print.
 * @returns The program, printing its defect on the Reporter's stderr.
 */
export function reportCrash<E, R>(program: Effect.Effect<void, E, R>): Effect.Effect<void, E, R | Reporter> {
  return program.pipe(
    Effect.tapDefect((defect) =>
      Reporter.use((reporter) =>
        reporter.stderr(
          `elmera-intl failed: ${defect instanceof Error ? (defect.stack ?? defect.message) : String(defect)}\n`
        )
      )
    )
  );
}

/** How a host running a command in-process takes a crash. */
export type CrashHandling =
  /** Print it as the CLI does (`elmera-intl failed: ` and the stack) and return `"crashed"`. */
  | "report"
  /** Reject with the thrown Error, for a host that reports a crash its own way. */
  | "reject";

/** How a one-shot command ended: clean, with problems it printed, or crashed. */
export type OneShotOutcome = "ok" | "problems" | "crashed";

/**
 * Run `elmera-intl <command> --config <configPath>` in-process, for a host: the same output as the executable, without
 * parsing arguments.
 *
 * @param command - The command to run.
 * @param options - The project's config path and how a crash is taken.
 * @param io - The host's output streams.
 * @returns `"ok"` when clean, `"problems"` when the command printed problems, `"crashed"` on a reported crash.
 * @throws The thrown Error, when the command crashes and `crash` is `"reject"`.
 */
export async function runOnceInProcess(
  command: OneShotCommand,
  options: { readonly configPath: string; readonly crash: CrashHandling },
  io: ReporterIo
): Promise<OneShotOutcome> {
  const program = runOnce(command, false, options.configPath);
  const exit = await Effect.runPromiseExit(
    (options.crash === "report" ? reportCrash(program) : program).pipe(Effect.provide(Reporter.layer(io)))
  );

  if (Exit.isSuccess(exit)) {
    return "ok";
  }

  if (Cause.hasDies(exit.cause)) {
    if (options.crash === "reject") {
      throw Cause.squash(exit.cause);
    }

    return "crashed";
  }

  // The only failure a one-shot run has is its problems; anything else is an interruption, which nothing here sends.
  return Cause.hasFails(exit.cause) ? "problems" : "crashed";
}
