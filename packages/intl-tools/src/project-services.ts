// The project's services as each host provides them at its edge (the bin's run-main, the Vite sessions, Vitest's run):
// Node's file system and paths from @effect/platform-node-shared, and over them the catalogs' storage, the runtime's
// parse caches and its formats memo. Built once per runtime, so the memos live as long as it.
//
// Every platform module is imported when it is first needed, never with an entry: Node's file system and paths when a
// runtime is built, its child processes (and the evaluation over them) only when a check first evaluates a formats
// module. Importing `./vite` or `./vitest` pays for none of them.
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import { CatalogFiles } from "./catalog-files";
import { SourceCaches } from "./project";
import type { FormatsEvaluator } from "./project-formats-service";
import { ProjectFormats } from "./project-formats-service";

/** Node's platform services: its file system and paths. */
export type NodePlatformServices = FileSystem.FileSystem | Path.Path;

/** Node's file system and paths, from @effect/platform-node-shared, imported as the layer is built. */
export const NodePlatform: Layer.Layer<NodePlatformServices> = /* @__PURE__ */ Layer.unwrap(
  /* @__PURE__ */ Effect.promise(async () => {
    const [files, paths] = await Promise.all([
      import("@effect/platform-node-shared/NodeFileSystem"),
      import("@effect/platform-node-shared/NodePath"),
    ]);

    return Layer.merge(files.layer, paths.layer);
  })
);

// The formats evaluator on Node's child processes, imported with the evaluation itself on first use. The spawner's
// layer needs the file system and paths, which it takes from Node's.
const nodeFormatsEvaluator: Effect.Effect<FormatsEvaluator> = /* @__PURE__ */ Effect.promise(async () => {
  const [spawner, evaluation] = await Promise.all([
    import("@effect/platform-node-shared/NodeChildProcessSpawner"),
    import("./formats-evaluation"),
  ]);
  const spawning = Layer.provide(spawner.layer, NodePlatform);

  return (path: string) => evaluation.evaluateFormatsModule(path).pipe(Effect.provide(spawning));
});

/** What the commands run on: the catalogs' storage, the runtime's memos and the platform under them. */
export type ProjectServices = CatalogFiles | SourceCaches | ProjectFormats | NodePlatformServices;

/**
 * The commands' services on Node, each memo fresh: one per runtime.
 *
 * @param files - The catalogs' storage; `CatalogFiles.layer()` unless a test stands between its operations.
 * @returns The layer.
 */
export function projectServices(
  files: Layer.Layer<CatalogFiles, never, FileSystem.FileSystem> = CatalogFiles.layer()
): Layer.Layer<ProjectServices> {
  return Layer.mergeAll(files, SourceCaches.layer, ProjectFormats.layer(nodeFormatsEvaluator)).pipe(
    Layer.provideMerge(NodePlatform)
  );
}
