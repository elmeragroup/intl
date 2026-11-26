// The project config as the hosts' Effect programs read it: through `FileSystem` and `Path`, decoded with
// `effect/Schema`. `parseConfig` (project-config.ts) stays the hand parser `withIntl` runs inside next.config, where
// Effect never goes; both word every problem from the same texts, check in the same order and report the first, which
// `test/project-config.test.ts` holds as a differential.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { posix } from "node:path";

import { nodeSyncError, readText } from "./catalog-files";
import type { ConfigLoaded } from "./project-config";
import {
  configInvalid,
  escapingGlob,
  FIELD_PROBLEMS,
  firstEscaping,
  FORMATS_MODULE,
  sharedCatalogPath,
} from "./project-config";

// Glob patterns, normalized as `parseConfig` normalizes them (`./src/**` is `src/**`).
const normalized = (patterns: ReadonlyArray<string>) => patterns.map((pattern) => posix.normalize(pattern));

// The config in two stages, each reporting its first failure, so the order is `parseConfig`'s: the globs and whether
// any reaches outside the root (which needs both lists), then the locales, the catalogs and the formats. Last, as
// there, whether two locales' catalog paths could name one file (`sharedCatalogPath`), which needs both fields.
const Globs = /* @__PURE__ */ Schema.Struct({
  include: /* @__PURE__ */ Schema.Array(Schema.String).check(/* @__PURE__ */ Schema.isMinLength(1)),
  exclude: /* @__PURE__ */ Schema.optionalKey(/* @__PURE__ */ Schema.Array(Schema.String)),
}).check(
  /* @__PURE__ */ Schema.makeFilter((globs) => {
    const escaping = firstEscaping(normalized([...globs.include, ...(globs.exclude ?? [])]));

    return escaping === undefined ? undefined : escapingGlob(escaping);
  })
);

const Catalogs = /* @__PURE__ */ Schema.Struct({
  locales: /* @__PURE__ */ Schema.Array(Schema.String).check(/* @__PURE__ */ Schema.isMinLength(1)),
  catalogs: /* @__PURE__ */ Schema.String.check(
    /* @__PURE__ */ Schema.makeFilter((pattern) => pattern.includes("{locale}") && pattern.endsWith(".po"))
  ),
  formats: /* @__PURE__ */ Schema.optionalKey(
    /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.isPattern(FORMATS_MODULE))
  ),
});

const decodeGlobs = /* @__PURE__ */ Schema.decodeUnknownResult(Globs, { errors: "first" });
const decodeCatalogs = /* @__PURE__ */ Schema.decodeUnknownResult(Catalogs, { errors: "first" });
const formatIssue = /* @__PURE__ */ SchemaIssue.makeFormatterStandardSchemaV1();

// A stage's first failure as the problem's text: the field's own text, whatever is wrong with it (missing, not a list,
// an item not a string, empty); the escaping glob's text from the check that found it.
function failureText(error: Schema.SchemaError): string {
  const [first] = formatIssue(error.issue).issues;
  const field = first?.path?.[0];
  const key = Predicate.hasProperty(field, "key") ? field.key : field;
  const fieldText = new Map<PropertyKey | undefined, string>(Object.entries(FIELD_PROBLEMS)).get(key);

  return fieldText ?? first?.message ?? error.message;
}

/**
 * Decode the project config from the file's text, as `parseConfig` parses it: the same config, or the same first
 * problem in the same words.
 *
 * @param text - The content of `elmera-intl.json`.
 * @param path - Its path as the user supplied it: the problems name it verbatim.
 * @param root - The absolute directory holding it, which the config's paths are relative to.
 * @param paths - The host's paths, which resolve `formats` against the root.
 * @returns The config, or the problem with it.
 */
export function decodeConfig(
  text: string,
  path: string,
  root: string,
  paths: Pick<Path.Path, "resolve">
): ConfigLoaded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return configInvalid(path, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  // An object, as `parseConfig` takes one: a JSON array is one too, whose fields are its indices.
  if (!Predicate.isObjectOrArray(raw)) {
    return configInvalid(path, "not a JSON object");
  }

  const fields = Object.fromEntries(Object.entries(raw));
  const globs = decodeGlobs(fields);

  if (Result.isFailure(globs)) {
    return configInvalid(path, failureText(globs.failure));
  }

  const catalogs = decodeCatalogs(fields);

  if (Result.isFailure(catalogs)) {
    return configInvalid(path, failureText(catalogs.failure));
  }

  const { formats } = catalogs.success;
  const shared = sharedCatalogPath(catalogs.success.catalogs, catalogs.success.locales);

  if (shared !== undefined) {
    return configInvalid(path, shared);
  }

  return {
    _tag: "Config",
    config: {
      root,
      include: normalized(globs.success.include),
      exclude: normalized(globs.success.exclude ?? []),
      catalogs: catalogs.success.catalogs,
      locales: catalogs.success.locales,
      // As parseConfig resolves it: resolve, not join, so an absolute formats path stays as written.
      formats: formats === undefined ? undefined : paths.resolve(root, formats),
    },
  };
}

/**
 * Read and decode the project config, as `loadConfig` reads and parses it. The read is the boundary that resolves a
 * relative path, against the working directory; every caller passes an absolute one.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The config, or the problem with it.
 */
export const readConfig = /* @__PURE__ */ Effect.fn("elmera-intl.readConfig")(function* (path: string) {
  const files = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  // Absent as the file system says (Node's existsSync, project-services.ts): "not found". A check that fails (a read
  // the permission model denies) is the crash it was when loadConfig threw it.
  const exists = yield* files.exists(path).pipe(Effect.mapError(nodeSyncError), Effect.orDie);

  if (!exists) {
    return configInvalid(path, `${path} not found`);
  }

  // A read failure (a directory, no permission) reads as "not JSON", as it did when the read and the parse shared one
  // try: the CLI's output stays as it was.
  return yield* readText(files, path).pipe(
    Effect.match({
      onFailure: (error) => configInvalid(path, `not JSON: ${nodeSyncError(error).message}`),
      onSuccess: (text) => decodeConfig(text, path, paths.dirname(paths.resolve(path)), paths),
    })
  );
});

// Whether a path exists as Node's existsSync says, which `readConfig` asks, but through the file system's asynchronous
// `access` and then `stat`, as existsSync stats a path `access` reached where that can succeed on a dangling link
// (Windows; node src/node_file.cc, v26.13.0, lines 1099-1109). On POSIX `access` follows the link, so the stat changes
// nothing there. Any failure to reach the path is absent, as existsSync swallows every error, except a check the
// permission model denies, which existsSync throws, so it is the crash it is in `readConfig`.
const existsAsNode = (files: FileSystem.FileSystem, path: string) =>
  files.access(path).pipe(
    Effect.andThen(files.stat(path)),
    Effect.as(true),
    Effect.catch((error) =>
      Predicate.hasProperty(error.reason.cause, "code") && error.reason.cause.code === "ERR_ACCESS_DENIED"
        ? Effect.die(nodeSyncError(error))
        : Effect.succeed(false)
    )
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
 * read. One read, asynchronous and interruptible, with no check before it, so a read stalled on a mount never holds a
 * stop. Only a read that failed asks whether the path exists, as `readConfig` asks first (Node's existsSync), and asks
 * asynchronously too (`existsAsNode`), so a lookup stalled on a mount holds no stop either: "not found" when it does not
 * (a missing file, a dangling or looping link, a file or an unreadable directory on the way), "not JSON" when it does.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The text read (none when the file is missing or cannot be read) and the config, or the problem with it.
 */
export const readConfigSnapshot = /* @__PURE__ */ Effect.fn("elmera-intl.readConfigSnapshot")(function* (
  path: string
) {
  const files = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const read = yield* Effect.result(readText(files, path));

  if (Result.isSuccess(read)) {
    return {
      text: read.success,
      loaded: decodeConfig(read.success, path, paths.dirname(paths.resolve(path)), paths),
    } satisfies ConfigSnapshot;
  }

  const exists = yield* existsAsNode(files, path);

  return {
    text: undefined,
    loaded: configInvalid(
      path,
      exists ? `not JSON: ${nodeSyncError(read.failure).message}` : `${path} not found`
    ),
  } satisfies ConfigSnapshot;
});
