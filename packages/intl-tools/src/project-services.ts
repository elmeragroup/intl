// The project's services as each host provides them at its edge (the bin's run-main, the Vite sessions, Vitest's run):
// Node's file system and paths from @effect/platform-node-shared, and over them the catalogs' storage, the sources'
// discovery (Node's glob), the runtime's parse caches and its formats memo. Built once per runtime, so the memos live as long as it.
//
// Every platform module is imported when it is first needed, never with an entry: Node's file system and paths when a
// runtime is built. Importing `./vite` or `./vitest` pays for none of them. (A formats module is evaluated with
// `spawnSync`, not Node's `ChildProcessSpawner`: see `evaluateModule` in project-formats.ts.)
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import { existsSync } from "node:fs";

import { CatalogFiles } from "./catalog-files";
import { SourceCaches, SourceDiscovery } from "./project";
import { ProjectFormats } from "./project-formats-service";
import { realPathAsync } from "./real-path";

/** Node's platform services: its file system and paths. */
export type NodePlatformServices = FileSystem.FileSystem | Path.Path;

/**
 * Whether a path exists, as Node's `existsSync` says, which the CLI has always asked: any failure to reach the path (a
 * self-looping link, a file where a directory goes) is absent, while a read the permission model denies
 * (`ERR_ACCESS_DENIED`) is thrown, so it fails where it did. `FileSystem.exists` swallows only "not found".
 *
 * @param path - The path.
 * @returns Whether it exists; fails when Node's check throws.
 */
export const nodeExists = (path: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.try({
    try: () => existsSync(path),
    catch: (cause) =>
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "exists",
        pathOrDescriptor: path,
        cause,
      }),
  });

// The reasons a lookup of a real path fails with, by Node's error code; any other is `Unknown`.
const REAL_PATH_REASONS = new Map<string, PlatformError.SystemErrorTag>([
  ["ENOENT", "NotFound"],
  ["ENOTDIR", "NotFound"],
  ["EACCES", "PermissionDenied"],
  ["EPERM", "PermissionDenied"],
  ["ELOOP", "BadResource"],
]);

/**
 * A path's real path, the hosts' way (`realPathAsync`, real-path.ts: the kernel's on POSIX, as Next and Vite
 * resolve it), where Node's `FileSystem.realPath` takes the JavaScript `fs.realpath` on POSIX. Asynchronous, so a
 * lookup stalled on a mount holds no stop of the watch.
 *
 * @param path - The path.
 * @returns The real path; fails with Node's error as the cause when it does not resolve.
 */
export const nodeRealPath = (path: string): Effect.Effect<string, PlatformError.PlatformError> =>
  Effect.callback<string, PlatformError.PlatformError>((resume) => {
    // Node throws before it calls back on an argument it refuses (a path with a NUL byte, ERR_INVALID_ARG_VALUE): a
    // failure like the callback's, as Node's `FileSystem.realPath` made it, never a defect.
    try {
      realPathAsync(path, (error, resolved) => {
        resume(error === null ? Effect.succeed(resolved) : Effect.fail(realPathFailure(path, error)));
      });
    } catch (error) {
      resume(Effect.fail(realPathFailure(path, error)));
    }
  });

// A failed lookup of `path`'s real path, Node's error its cause and its code the reason.
function realPathFailure(path: string, cause: unknown): PlatformError.PlatformError {
  const code = Predicate.hasProperty(cause, "code") ? String(cause.code) : "";

  return PlatformError.systemError({
    _tag: REAL_PATH_REASONS.get(code) ?? "Unknown",
    module: "FileSystem",
    method: "realPath",
    pathOrDescriptor: path,
    cause,
  });
}

/**
 * Node's file system and paths, from @effect/platform-node-shared, imported as the layer is built; its `exists` is
 * Node's `existsSync`, and its `realPath` the hosts' way (`nodeRealPath`).
 */
export const NodePlatform: Layer.Layer<NodePlatformServices> = /* @__PURE__ */ Layer.unwrap(
  /* @__PURE__ */ Effect.promise(async () => {
    const [files, paths] = await Promise.all([
      import("@effect/platform-node-shared/NodeFileSystem"),
      import("@effect/platform-node-shared/NodePath"),
    ]);
    const nodeFiles = Layer.effect(
      FileSystem.FileSystem,
      FileSystem.FileSystem.useSync((live) => ({ ...live, exists: nodeExists, realPath: nodeRealPath }))
    ).pipe(Layer.provide(files.layer));

    return Layer.merge(nodeFiles, paths.layer);
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
 * @param platform - The file system and paths under them; Node's unless a test reads synchronously.
 * @returns The layer.
 */
export function projectServices(
  files: Layer.Layer<CatalogFiles, never, FileSystem.FileSystem> = CatalogFiles.layer(),
  platform: Layer.Layer<NodePlatformServices> = NodePlatform
): Layer.Layer<ProjectServices> {
  return Layer.mergeAll(files, SourceDiscovery.node, SourceCaches.layer, ProjectFormats.layer).pipe(
    Layer.provideMerge(platform)
  );
}
