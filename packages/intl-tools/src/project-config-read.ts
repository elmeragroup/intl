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
import { configInvalid, escapingGlob, FIELD_PROBLEMS, firstEscaping, FORMATS_MODULE } from "./project-config";

// Glob patterns, normalized as `parseConfig` normalizes them (`./src/**` is `src/**`).
const normalized = (patterns: ReadonlyArray<string>) => patterns.map((pattern) => posix.normalize(pattern));

// The config in two stages, each reporting its first failure, so the order is `parseConfig`'s: the globs and whether
// any reaches outside the root (which needs both lists), then the locales, the catalogs and the formats.
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

  const text = yield* readText(files, path).pipe(Effect.result);

  // A read failure (a directory, no permission) reads as "not JSON", as it did when the read and the parse shared one
  // try: the CLI's output stays as it was.
  if (text._tag === "Failure") {
    return configInvalid(path, `not JSON: ${text.failure.reason()}`);
  }

  return decodeConfig(text.success, path, paths.dirname(paths.resolve(path)), paths);
});
