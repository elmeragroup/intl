// The app's `formats` as the hosts' Effect programs load them (`check`): the module read through `FileSystem`,
// evaluated in a Node child process by `evaluateModule` (project-formats.ts, `spawnSync`: see there why not
// effect/process), and judged as the loaders judge it. The memo of evaluations lives in the service, so each host
// runtime (a CLI run, a Vite session) owns its own.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { readText } from "./catalog-files";
import type { ProjectConfig } from "./project-config";
import type { Evaluated, FormatsLoaded, FormatsMemo } from "./project-formats";
import { evaluateModule, judgeFormats } from "./project-formats";

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
  /** Formats read through the host's file system and evaluated by `spawnSync`, with a memo for the runtime. */
  static readonly layer: Layer.Layer<ProjectFormats, never, FileSystem.FileSystem> =
    /* @__PURE__ */ Layer.effect(
      ProjectFormats,
      /* @__PURE__ */ Effect.gen(function* () {
        const files = yield* FileSystem.FileSystem;
        const memo: FormatsMemo = new Map();

        const evaluated = Effect.fnUntraced(function* (path: string) {
          const content = yield* readText(files, path).pipe(Effect.result);

          if (content._tag === "Failure") {
            return { _tag: "FormatsUnloadable", reason: content.failure.reason() } satisfies Evaluated;
          }

          const hit = memo.get(path);

          if (hit?.content === content.success) {
            return hit.result;
          }

          const result = yield* Effect.sync(() => evaluateModule(path));
          // Kept only while the module still holds the text read before the evaluation, so a save that lasts past it (an
          // editor's truncate-then-write) is not memoized under the earlier text. An edit undone before this re-read
          // still can be: the child imports the module itself, as 963d3e4's did, a race this narrows but does not close.
          const after = yield* readText(files, path).pipe(Effect.result);

          if (after._tag === "Success" && after.success === content.success) {
            memo.set(path, { content: content.success, result });
          }

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
