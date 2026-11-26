// One `extract` or `check` run and its report, with no argument parsing: the CLI (cli-run.ts) runs it for a parsed
// command line, and the hosts (the Vite build check, the Vitest setup) call it directly, so they print, and exit,
// alike without loading effect/cli.

import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import type { ProjectIoFailed } from "./catalog-files";
import type { CheckRun, CommandReport } from "./commands";
import { runCheck, runExtract } from "./commands";
import type { Problem } from "./problem";
import { describeProblem } from "./problem";
import { readConfig } from "./project-config-read";
import type { ProjectServices } from "./project-services";
import { projectServices } from "./project-services";
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

// The command's report, with the source files a check read (none for an extract: no host watches what it read). I/O
// the commands do not classify is the crash it was: the error Node raised is the defect, so it prints with its own
// stack and a host that rejects on a crash rejects with it.
const commandReport = /* @__PURE__ */ Effect.fn("elmera-intl.report")(function* (
  command: OneShotCommand,
  configPath: string
) {
  const loaded = yield* readConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    return {
      report: { problems: [loaded.problem], messages: 0, written: [], unreachable: [] },
      sources: [],
    } satisfies CheckRun;
  }

  const run: Effect.Effect<CheckRun, ProjectIoFailed, ProjectServices> =
    command === "extract"
      ? runExtract(loaded.config).pipe(Effect.map((report) => ({ report, sources: [] })))
      : runCheck(loaded.config);

  return yield* run.pipe(Effect.catchTag("ProjectIoFailed", (failure) => Effect.die(failure.cause)));
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
  const { problems } = yield* printedRun(command, json, configPath);

  if (problems > 0) {
    return yield* new ProblemsFound({ count: problems });
  }
});

// `runOnce`'s run and report, ending in how many problems it printed and the source files a check read.
const printedRun = /* @__PURE__ */ Effect.fn("elmera-intl.printed")(function* (
  command: OneShotCommand,
  json: boolean,
  configPath: string
) {
  const reporter = yield* Reporter;
  const { report, sources } = yield* commandReport(command, configPath);

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

  return { problems: report.problems.length, sources };
});

function renderJsonReport(report: CommandReport): string {
  return `${JSON.stringify({ ok: report.problems.length === 0, ...report }, null, 2)}\n`;
}

/**
 * Print a defect as `elmera-intl failed: ` and the thrown Error's own stack. It stays a defect, which the
 * executable reads as exit 2.
 *
 * @template A - The program's result.
 * @template E - The program's failures.
 * @template R - The program's requirements.
 * @param program - The program whose defect to print.
 * @returns The program, printing its defect on the Reporter's stderr.
 */
export function reportCrash<A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Reporter> {
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

/** A one-shot command as a host ran it in-process: how it ended, and the source files a check read. */
export type InProcessRun = {
  /** Clean, with problems it printed, or crashed. */
  readonly outcome: OneShotOutcome;
  /** Each source file the check read, as its path joined to the project root; none for an extract or a crash. */
  readonly sources: ReadonlyArray<string>;
};

/**
 * `elmera-intl <command> --config <configPath>` as a host runs it in-process: the same output as the executable,
 * without parsing arguments, ending in how it went and what a check read. A watch build watches those sources, so a
 * repair of one checks again even when the failed check stopped the build from loading it.
 *
 * @param command - The command to run.
 * @param options - The project's config path and how a crash is taken.
 * @returns An effect that writes the report on the Reporter and succeeds with the outcome (`"ok"` when clean,
 *   `"problems"` when the command printed problems, `"crashed"` on a reported crash) and the sources a check read; with
 *   `crash: "reject"`, a crash stays its defect.
 */
export const inProcessRun = /* @__PURE__ */ Effect.fn("elmera-intl.inProcess")(function* (
  command: OneShotCommand,
  options: { readonly configPath: string; readonly crash: CrashHandling }
) {
  const program = printedRun(command, false, options.configPath).pipe(
    Effect.map(({ problems, sources }): InProcessRun => ({
      outcome: problems > 0 ? "problems" : "ok",
      sources,
    }))
  );

  return yield* options.crash === "report"
    ? reportCrash(program).pipe(
        Effect.catchDefect(() => Effect.succeed<InProcessRun>({ outcome: "crashed", sources: [] }))
      )
    : program;
});

/**
 * `inProcessRun`'s outcome alone, for a host that watches nothing.
 *
 * @param command - The command to run.
 * @param options - The project's config path and how a crash is taken.
 * @returns An effect that writes the report on the Reporter and succeeds with `"ok"` when clean, `"problems"` when the
 *   command printed problems, `"crashed"` on a reported crash; with `crash: "reject"`, a crash stays its defect.
 */
export const oneShot = /* @__PURE__ */ Effect.fn("elmera-intl.oneShot")(function* (
  command: OneShotCommand,
  options: { readonly configPath: string; readonly crash: CrashHandling }
) {
  const { outcome } = yield* inProcessRun(command, options);

  return outcome;
});

/**
 * Run `oneShot` outside an Effect program, on the host's output streams and the project's services on Node, built for
 * this run.
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
  return Effect.runPromise(
    oneShot(command, options).pipe(Effect.provide([Reporter.layer(io), projectServices()]))
  );
}
