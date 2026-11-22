// A problem the tools report, and its one printed form. A leaf: the loaders print problems too, and importing this
// from the CLI would load the CLI, its commands and the watcher into every loader worker.

/** A problem the CLI reports, with the fix it names. */
export type Problem = {
  /** Stable identifier for tooling. */
  readonly code: string;
  readonly message: string;
  /** What to do about it. */
  readonly fix: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly locale?: string;
  readonly key?: string;
};

/**
 * A problem as the CLI prints it: location, code, message, key, and the fix on its own line.
 *
 * @param problem - The problem.
 * @returns Human-readable text, without a trailing newline.
 */
export function describeProblem(problem: Problem): string {
  const where = [problem.file, problem.line, problem.column].filter((part) => part !== undefined).join(":");
  const key = problem.key === undefined ? "" : ` [${JSON.stringify(problem.key)}]`;

  return `${where ? `${where}: ` : ""}${problem.code}: ${problem.message}${key}\n  fix: ${problem.fix}`;
}
