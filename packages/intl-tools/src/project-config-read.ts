// The project config as the hosts' Effect programs read it, through `FileSystem`: the CLI, `check` in Vite and Vitest
// (`readConfig`), and the watch (`readConfigSnapshot`). Two reads, one parser: each hands the text it read to
// `parseConfig` (project-config.ts), the parser `withIntl` runs inside next.config, so every host reads one config or
// words one problem.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { nodeSyncError, readText } from "./catalog-files";
import type { ConfigLoaded, ConfigLocation } from "./project-config";
import { configDirectory, configIn, configInvalid, configUnreadable, parseConfig } from "./project-config";

/**
 * Read the project config through the file system, as `loadConfig` reads it, and parse it with the one parser,
 * `parseConfig`. The read is the boundary that resolves a relative path, against the working directory; every caller
 * passes an absolute one. The file is read in the directory its root names (`readConfigLocation`), so the text and the
 * root are one directory's.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The config, or the problem with it.
 */
export const readConfig = /* @__PURE__ */ Effect.fn("elmera-intl.readConfig")(function* (path: string) {
  const files = yield* FileSystem.FileSystem;
  const location = yield* readConfigLocation(files, path);

  if (location === undefined) {
    return configInvalid(path, `${path} not found`);
  }

  const { root, file } = location;
  // Absent as the file system says (Node's existsSync, project-services.ts): "not found". A check that fails (a read
  // the permission model denies) is the crash it was when loadConfig threw it.
  const exists = yield* files.exists(file).pipe(Effect.mapError(nodeSyncError), Effect.orDie);

  if (!exists) {
    return configInvalid(path, `${path} not found`);
  }

  const read = yield* Effect.result(readText(files, file));

  if (Result.isFailure(read)) {
    return configUnreadable(path, file, nodeSyncError(read.failure).message);
  }

  // The config's fields are the file's own JSON properties only, so a field inherited from `Object.prototype` no longer
  // affects this read, as `loadConfig` already reads it.
  return parseConfig(read.success, path, root);
});

// Whether Node's permission model refused the call (`ERR_ACCESS_DENIED`): the one failure Node's existsSync throws
// rather than answers as absent.
const deniedByModel = (error: PlatformError.PlatformError) =>
  Predicate.hasProperty(error.reason.cause, "code") && error.reason.cause.code === "ERR_ACCESS_DENIED";

// Where the config is read, as `configLocation` (project-config.ts) finds it, through the file system: the directory
// the path names, resolved through its links, and the file in it (`configIn`); none when the directory does not
// resolve, which the readers report as "not found", as `configLocation` says why. A lookup the permission model denies
// is the crash Node's existsSync made it. Asynchronous, so a lookup stalled on a mount holds no stop of the watch.
const readConfigLocation = (
  files: FileSystem.FileSystem,
  path: string
): Effect.Effect<ConfigLocation | undefined> =>
  files.realPath(configDirectory(path)).pipe(
    Effect.map((root) => configIn(root, path)),
    Effect.catch((error) => (deniedByModel(error) ? Effect.die(nodeSyncError(error)) : Effect.undefined))
  );

// Whether a path exists as Node's existsSync says, which `readConfig` asks, but through the file system's asynchronous
// `access` and then `stat`, as existsSync stats a path `access` reached where that can succeed on a dangling link
// (Windows; node src/node_file.cc, v26.13.0, lines 1099-1109). On POSIX `access` follows the link, so the stat changes
// nothing there. Any failure to reach the path is absent, as existsSync swallows every error, except a check the
// permission model denies, which existsSync throws, so it is the crash it is in `readConfig`.
const existsAsNode = (files: FileSystem.FileSystem, path: string) =>
  files.access(path).pipe(
    Effect.andThen(files.stat(path)),
    Effect.as(true),
    Effect.catch((error) => (deniedByModel(error) ? Effect.die(nodeSyncError(error)) : Effect.succeed(false)))
  );

/** One read of the project config: the text read, and the config parsed from that same text. */
export type ConfigSnapshot = {
  /** The file's text; none when it is missing or cannot be read. */
  readonly text: string | undefined;
  /** The config parsed from `text`, or the problem with it. */
  readonly loaded: ConfigLoaded;
};

/**
 * The watch's read of the config (`followConfig`): `readConfig`'s config or problem, worded as there, and the text it
 * read. The config's directory is looked up first (`readConfigLocation`), and the file read in it, so the text and the
 * root are one directory's ("not found" when the directory does not resolve); both asynchronous and interruptible,
 * with no existence check before the read, so a lookup or a read stalled on a mount never holds a stop. Only a read
 * that failed asks whether the file exists, as `readConfig` asks first (Node's existsSync), and asks asynchronously
 * too (`existsAsNode`): "not found" when it does not (a missing file, a dangling or looping link, a file or an
 * unreadable directory on the way), "not JSON" when it does.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The text read (none when the file is missing or cannot be read) and the config, or the problem with it.
 */
export const readConfigSnapshot = /* @__PURE__ */ Effect.fn("elmera-intl.readConfigSnapshot")(function* (
  path: string
) {
  const files = yield* FileSystem.FileSystem;
  const location = yield* readConfigLocation(files, path);

  if (location === undefined) {
    return { text: undefined, loaded: configInvalid(path, `${path} not found`) } satisfies ConfigSnapshot;
  }

  const { root, file } = location;
  const read = yield* Effect.result(readText(files, file));

  if (Result.isSuccess(read)) {
    return {
      text: read.success,
      // The file's own JSON properties only, as in `readConfig`: a field inherited from `Object.prototype` no longer
      // affects this read, as `loadConfig` already reads it.
      loaded: parseConfig(read.success, path, root),
    } satisfies ConfigSnapshot;
  }

  const exists = yield* existsAsNode(files, file);

  return {
    text: undefined,
    loaded: exists
      ? configUnreadable(path, file, nodeSyncError(read.failure).message)
      : configInvalid(path, `${path} not found`),
  } satisfies ConfigSnapshot;
});
