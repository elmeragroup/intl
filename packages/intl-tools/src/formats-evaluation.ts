// Evaluating the app's formats module in a Node child process, through `ChildProcessSpawner`. Its own module, imported
// only when a check first evaluates a formats module (project-services.ts), so no entry's import graph carries the
// process machinery.
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import process from "node:process";

import type { Evaluated } from "./project-formats";
import { evaluationArgs, parseEvaluation } from "./project-formats";

/**
 * What a platform failure says: the error Node raised, as the synchronous load reported it.
 *
 * @param error - The failure.
 * @returns Its reason.
 */
export const reasonOf = (error: PlatformError.PlatformError): string => {
  const cause = error.reason.cause;

  return cause instanceof Error ? cause.message : error.message;
};

/**
 * Evaluate a formats module in a fresh Node: Node's module cache never evicts an ES module, so an in-process load
 * would keep the first content for the life of a dev server.
 *
 * @param path - The module's absolute path.
 * @returns What evaluating it gave; a failure to run Node is `FormatsUnloadable`.
 */
export const evaluateFormatsModule = /* @__PURE__ */ Effect.fnUntraced(
  function* (path: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, evaluationArgs(path), {
        // The host's NODE_OPTIONS (an inspector port, a loader) belong to the host, not to this evaluation.
        env: { NODE_OPTIONS: "" },
        extendEnv: true,
      })
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 2 }
    );

    return parseEvaluation(yield* handle.exitCode, stdout, stderr);
  },
  Effect.scoped,
  /* @__PURE__ */ Effect.catchTag("PlatformError", (error) =>
    Effect.succeed<Evaluated>({ _tag: "FormatsUnloadable", reason: reasonOf(error) })
  )
);
