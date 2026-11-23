// The project's services as each host provides them at its edge (the bin's run-main, the Vite sessions, Vitest's run):
// Node's file system and paths from @effect/platform-node-shared, and over them the catalogs' storage, the sources'
// discovery (Node's glob), the runtime's parse caches and its formats memo. Built once per runtime, so the memos live as long as it.
//
// Every platform module is imported when it is first needed, never with an entry: Node's file system and paths when a
// runtime is built. Importing `./vite` or `./vitest` pays for none of them. (A formats module is evaluated with
// `spawnSync`, not Node's `ChildProcessSpawner`: see `evaluateModule`.)
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import { CatalogFiles } from "./catalog-files";
import { SourceCaches, SourceDiscovery } from "./project";
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

/**
 * What the commands run on: the catalogs' storage, the sources' discovery, the runtime's memos and the platform under
 * them.
 */
export type ProjectServices =
  | CatalogFiles
  | SourceDiscovery
  | SourceCaches
  | ProjectFormats
  | NodePlatformServices;

/**
 * The commands' services on Node, each memo fresh: one per runtime.
 *
 * @param files - The catalogs' storage; `CatalogFiles.layer()` unless a test stands between its operations.
 * @returns The layer.
 */
export function projectServices(
  files: Layer.Layer<CatalogFiles, never, FileSystem.FileSystem> = CatalogFiles.layer()
): Layer.Layer<ProjectServices> {
  return Layer.mergeAll(files, SourceDiscovery.node, SourceCaches.layer, ProjectFormats.layer).pipe(
    Layer.provideMerge(NodePlatform)
  );
}
