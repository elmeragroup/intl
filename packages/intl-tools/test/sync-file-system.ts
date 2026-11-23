import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import type { Stats } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";

// Node's file system, the operations the project reads through run synchronously: each completes inside the fiber that
// asks, so a watch on the test clock syncs entirely within a `TestClock.adjust`, as it did when every read was sync.
// Node's own `FileSystem` (@effect/platform-node-shared) completes a read on a later turn of the event loop, which no
// test clock moves; the hosts and every real-time test run on it. Each failure is the `PlatformError` Node's
// `FileSystem` raises, the error Node threw as its cause.

const REASONS = new Map<string, PlatformError.SystemErrorTag>([
  ["ENOENT", "NotFound"],
  ["EACCES", "PermissionDenied"],
  ["EPERM", "PermissionDenied"],
  ["EEXIST", "AlreadyExists"],
  ["EISDIR", "BadResource"],
  ["ENOTDIR", "BadResource"],
  ["EBUSY", "Busy"],
  ["ELOOP", "BadResource"],
]);

const failed =
  (method: string, path: string) =>
  (cause: unknown): PlatformError.PlatformError => {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "";

    return PlatformError.systemError({
      _tag: REASONS.get(code) ?? "Unknown",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      cause,
    });
  };

const info = (stats: Stats): FileSystem.File.Info => ({
  type: stats.isFile()
    ? "File"
    : stats.isDirectory()
      ? "Directory"
      : stats.isSymbolicLink()
        ? "SymbolicLink"
        : "Unknown",
  mtime: Option.fromNullishOr(stats.mtime),
  atime: Option.fromNullishOr(stats.atime),
  birthtime: Option.fromNullishOr(stats.birthtime),
  dev: BigInt(stats.dev),
  ino: Option.some(BigInt(stats.ino)),
  mode: stats.mode,
  nlink: Option.some(BigInt(stats.nlink)),
  uid: Option.fromNullishOr(stats.uid),
  gid: Option.fromNullishOr(stats.gid),
  rdev: Option.some(BigInt(stats.rdev)),
  size: ByteSize.bytes(BigInt(stats.size)),
  blksize: Option.some(ByteSize.bytes(BigInt(stats.blksize))),
  blocks: Option.some(BigInt(stats.blocks)),
});

/** A `FileSystem` whose `exists`, `readFile` and `stat` are Node's synchronous calls; every other operation a no-op. */
export const SYNC_FILE_SYSTEM: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
  exists: (path) => Effect.sync(() => existsSync(path)),
  readFile: (path) =>
    Effect.try({ try: () => new Uint8Array(readFileSync(path)), catch: failed("readFile", path) }),
  stat: (path) => Effect.try({ try: () => info(statSync(path)), catch: failed("stat", path) }),
});
