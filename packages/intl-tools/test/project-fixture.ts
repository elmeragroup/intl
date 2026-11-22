import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";

// What a test keeps after its deadline to fail, and report why, before its own timeout fires: a tenth of the timeout,
// at most this, so a short in-process test keeps most of its time.
const MARGIN_MS = 2_000;
// How often a FIFO's writer retries its non-blocking open while no reader has the FIFO open.
const FIFO_RETRY_MS = 10;

/** Teardown a test registers: it runs when the test ends, finished before the next teardown starts. */
export type Cleanup = () => void | Promise<void>;

/**
 * A temporary project that one test owns, as a Vitest fixture: its own root, so a test that overruns its timeout can
 * only touch its own files, never the next test's; a deadline every wait in the test ends by; and the teardown of what
 * the test started.
 *
 * The deadline is the test's timeout less a margin, from when the fixture is set up. Every hang guard a test waits on
 * (`guard`, `spawnGuard`, `within`) ends by it, so however many waits a test makes, their guards sum to less than its
 * timeout: a guard fails the test, and the test never overruns.
 */
export type Project = {
  /** The project's root directory. */
  readonly root: string;
  /** The absolute path of `relative` under the root. */
  readonly path: (relative: string) => string;
  /** Writes `text` to `relative`, making its directories. */
  readonly write: (relative: string, text: string) => void;
  /** Reads `relative` as UTF-8. Never a FIFO: a read blocks the test's thread until a writer closes. */
  readonly read: (relative: string) => string;
  /**
   * The milliseconds left before the deadline, and at least 1 once it has passed: Node's spawn reads a zero timeout as
   * none, so a guard taken late still fires, at once.
   */
  readonly remainingMs: () => number;
  /** The hang guard of one `expect.poll`: the time left before the deadline. */
  readonly guard: () => { readonly timeout: number };
  /** The hang guard of one spawned process: killed by SIGKILL at the deadline, so its `close` always comes. */
  readonly spawnGuard: () => { readonly timeout: number; readonly killSignal: "SIGKILL" };
  /**
   * Waits for `waiting`, failing at the deadline instead.
   *
   * @template A - What `waiting` resolves to.
   * @param waiting - The promise to wait for.
   * @param what - What is awaited, for the failure's message.
   * @returns What `waiting` resolves to.
   */
  readonly within: <A>(waiting: Promise<A>, what: string) => Promise<A>;
  /** Runs `cleanup` when the test ends, before the root is removed; the last registered runs first. */
  readonly defer: (cleanup: Cleanup) => void;
  /** Makes the directory `relative` (made if missing) unreadable, until the test ends. */
  readonly lock: (relative: string) => void;
  /**
   * Opens the FIFO at `relative` to write, once a reader has it open: the open never blocks (it retries a non-blocking
   * open until the deadline), so no thread waits on a reader that never comes.
   *
   * @param relative - The FIFO's path under the root.
   * @returns A writer, closed when the test ends unless the test closes it first.
   */
  readonly openFifoWriter: (relative: string) => Promise<FifoWriter>;
};

/** The write end of a FIFO a reader has open. */
export type FifoWriter = {
  /** Writes `text`, which must fit the pipe's buffer: the write never blocks. */
  readonly write: (text: string) => void;
  /** Closes the write end; the reader then reads to its end. */
  readonly close: () => void;
};

/** A project and its teardown. */
export type OpenProject = {
  /** The project. */
  readonly project: Project;
  /** Runs every deferred cleanup, restores locked directories and removes the root. */
  readonly close: () => Promise<void>;
};

/**
 * Makes a temporary project for one test.
 *
 * @param prefix - The root directory's name prefix.
 * @param timeoutMs - The test's timeout, from which its deadline is set.
 * @returns The project, and its teardown for the fixture's cleanup.
 */
export function openProject(prefix: string, timeoutMs: number): OpenProject {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // Read on the monotonic clock: a wall-clock step neither shortens nor stretches the guards.
  const deadline = performance.now() + timeoutMs - Math.min(MARGIN_MS, timeoutMs / 10);
  const cleanups: Array<Cleanup> = [];
  const path = (relative: string) => join(root, relative);
  // oxlint-disable-next-line tests/no-wall-clock -- the time left before the hang guards' deadline, not a measured outcome.
  const remainingMs = () => Math.max(1, Math.floor(deadline - performance.now()));
  const defer = (cleanup: Cleanup) => {
    cleanups.push(cleanup);
  };
  const within = async <A>(waiting: Promise<A>, what: string): Promise<A> => {
    let settled = false;
    const settling = waiting.finally(() => {
      settled = true;
    });
    // Handled here too: a rejection that lands while the poll still waits is not reported as unhandled.
    settling.catch(() => undefined);
    await expect
      .poll(() => settled, {
        timeout: remainingMs(),
        message: `hang guard: ${what} did not settle before the deadline`,
      })
      .toBe(true);

    return settling;
  };

  const project: Project = {
    root,
    path,
    write: (relative, text) => {
      mkdirSync(dirname(path(relative)), { recursive: true });
      writeFileSync(path(relative), text);
    },
    read: (relative) => readFileSync(path(relative), "utf8"),
    remainingMs,
    guard: () => ({ timeout: remainingMs() }),
    spawnGuard: () => ({ timeout: remainingMs(), killSignal: "SIGKILL" }),
    within,
    defer,
    lock: (relative) => {
      mkdirSync(path(relative), { recursive: true });
      chmodSync(path(relative), 0o000);
      defer(() => {
        chmodSync(path(relative), 0o755);
      });
    },
    openFifoWriter: async (relative) => {
      const writer = await vi.waitFor(
        () => {
          const fd = openWithReader(path(relative));

          if (fd === undefined) {
            throw new Error(`no reader has ${relative} open`);
          }

          return fd;
        },
        { timeout: remainingMs(), interval: FIFO_RETRY_MS }
      );
      let open = true;
      const close = () => {
        if (open) {
          open = false;
          closeSync(writer);
        }
      };
      defer(close);

      return {
        write: (text) => {
          writeSync(writer, text);
        },
        close,
      };
    },
  };

  // Each teardown in turn, the last registered first: a watch is stopped before the directories it reads are restored.
  const close = async () => {
    const failures = await cleanups
      .toReversed()
      .reduce<Promise<ReadonlyArray<unknown>>>(async (earlier, cleanup) => {
        const failed = await earlier;
        try {
          await cleanup();

          return failed;
        } catch (failure) {
          return [...failed, failure];
        }
      }, Promise.resolve([]));
    rmSync(root, { recursive: true, force: true });

    if (failures.length > 0) {
      throw new AggregateError(failures, "a test's cleanup failed");
    }
  };

  return { project, close };
}

// The FIFO opened to write without blocking: undefined while no reader has it open (ENXIO), so the caller retries.
function openWithReader(fifo: string): number | undefined {
  try {
    return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENXIO") {
      return undefined;
    }

    throw error;
  }
}
