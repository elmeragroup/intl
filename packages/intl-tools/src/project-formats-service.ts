// The app's `formats` as the hosts' Effect programs load them (`check`): the module read through `FileSystem`,
// evaluated by the host's evaluator (a Node child process, formats-evaluation.ts), and judged as the loaders judge it
// (project-formats.ts). The memo of evaluations lives in the service, so each host runtime (a CLI run, a Vite session)
// owns its own.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { readText } from "./catalog-files";
import type { ProjectConfig } from "./project-config";
import type { Evaluated, FormatsLoaded, FormatsMemo } from "./project-formats";
import { judgeFormats } from "./project-formats";

/** Evaluates a formats module at an absolute path. */
export type FormatsEvaluator = (path: string) => Effect.Effect<Evaluated>;

// What a read failure says: the error Node raised, as the synchronous load reported it.
const reasonOf = (error: {
  readonly message: string;
  readonly reason: { readonly cause?: unknown };
}): string => {
  const cause = error.reason.cause;

  return cause instanceof Error ? cause.message : error.message;
};

/** The app's `formats`, loaded for a host runtime. */
export class ProjectFormats
  extends /* @__PURE__ */ Context.Service<
    ProjectFormats,
    {
      /**
       * Load the app's `formats` from the module the config names, as `loadFormats` does: evaluated again whenever the
       * module's content changes.
       *
       * @param config - The project config.
       * @returns The formats (undefined when the config names none), or why the module does not provide them.
       */
      readonly load: (config: ProjectConfig) => Effect.Effect<FormatsLoaded>;
    }
  >()("elmera-intl-tools/ProjectFormats")
{
  /**
   * Formats read through the host's file system and evaluated by `evaluator`, with a memo for the runtime.
   *
   * @param evaluator - Makes the evaluator; run once, when a check first evaluates a module, so a run with no formats
   *   module never loads what evaluating takes.
   * @returns The layer.
   */
  static layer(
    evaluator: Effect.Effect<FormatsEvaluator>
  ): Layer.Layer<ProjectFormats, never, FileSystem.FileSystem> {
    return Layer.effect(
      ProjectFormats,
      Effect.gen(function* () {
        const files = yield* FileSystem.FileSystem;
        const evaluate = yield* Effect.cached(evaluator);
        const memo: FormatsMemo = new Map();

        const evaluated = Effect.fnUntraced(function* (path: string) {
          const content = yield* readText(files, path).pipe(Effect.result);

          if (content._tag === "Failure") {
            return { _tag: "FormatsUnloadable", reason: reasonOf(content.failure) } satisfies Evaluated;
          }

          const hit = memo.get(path);

          if (hit?.content === content.success) {
            return hit.result;
          }

          const result = yield* (yield* evaluate)(path);
          memo.set(path, { content: content.success, result });

          return result;
        });

        return {
          load: Effect.fn("ProjectFormats.load")(function* (config: ProjectConfig) {
            return config.formats === undefined
              ? ({ _tag: "Formats", formats: undefined } satisfies FormatsLoaded)
              : judgeFormats(config.root, config.formats, yield* evaluated(config.formats));
          }),
        };
      })
    );
  }
}
