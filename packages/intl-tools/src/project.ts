// A project the CLI works on: its sources and the messages they declare (project-config.ts reads its config,
// project-catalogs.ts places its catalogs, project-formats.ts loads its formats).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { createHash } from "node:crypto";
import { globSync } from "node:fs";
import { isAbsolute, matchesGlob, relative, sep } from "node:path";

import type { ProjectIoFailed } from "./catalog-files";
import { ioEdge, platformFailed, readText } from "./catalog-files";
import { extractMessages } from "./extract";
import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE } from "./project-config";

/**
 * Extraction results by project-relative path, each with its source's content hash, so a rescan parses only changed
 * files. `scanProject` drops entries for files no longer scanned.
 */
export type ParseCache = Map<
  string,
  { readonly hash: string; readonly result: ReturnType<typeof extractMessages> }
>;

/**
 * The parse caches of a runtime's scans, one per project root, so they live as long as the host's runtime (a dev
 * server's watch, a build's checks, one CLI run) and a scan of one project never evicts another's.
 */
export class SourceCaches
  extends /* @__PURE__ */ Context.Service<
    SourceCaches,
    {
      /**
       * The cache of the project at `root`, made on first use.
       *
       * @param root - The project root.
       * @returns Its cache, which each scan updates in place.
       */
      readonly of: (root: string) => ParseCache;
    }
  >()("elmera-intl-tools/SourceCaches")
{
  /** Empty caches, for one runtime. */
  static readonly layer: Layer.Layer<SourceCaches> = /* @__PURE__ */ Layer.sync(SourceCaches, () => {
    const caches = new Map<string, ParseCache>();

    return {
      of: (root) => {
        const cache = caches.get(root) ?? new Map();
        caches.set(root, cache);

        return cache;
      },
    };
  });
}

/**
 * How the scan finds the files an include pattern names: on Node, Node's glob, as the CLI always has. `scanProject`
 * then decides membership with `isProjectSource`.
 */
export class SourceDiscovery
  extends /* @__PURE__ */ Context.Service<
    SourceDiscovery,
    {
      /**
       * The paths under `root` that `pattern` matches, outside every `exclude` pattern (which only prunes the walk).
       *
       * @param root - The project root.
       * @param pattern - An include pattern, root-relative.
       * @param exclude - Patterns whose matches the walk skips.
       * @returns Root-relative paths, directories included.
       */
      readonly find: (
        root: string,
        pattern: string,
        exclude: ReadonlyArray<string>
      ) => Effect.Effect<ReadonlyArray<string>, ProjectIoFailed>;
    }
  >()("elmera-intl-tools/SourceDiscovery")
{
  /**
   * Node's `globSync` on the host's disk: the walk the CLI has always taken. `FileSystem.glob` documents its own
   * rules (dot files, `dir/**` matching `dir`, links to directories, unreadable directories skipped), and nothing shows
   * the two pick the same files, so Node's hosts keep this one.
   */
  static readonly node: Layer.Layer<SourceDiscovery> = /* @__PURE__ */ Layer.succeed(SourceDiscovery, {
    find: /* @__PURE__ */ Effect.fn("SourceDiscovery.find")(function* (
      root: string,
      pattern: string,
      exclude: ReadonlyArray<string>
    ) {
      return yield* ioEdge("scan", () => globSync(pattern, { cwd: root, exclude: [...exclude] }));
    }),
  });
}

/** A message and every file that uses it. */
export type ProjectMessage = {
  readonly key: string;
  readonly source: string;
  readonly context: string | undefined;
  readonly references: ReadonlyArray<string>;
  readonly comments: ReadonlyArray<string>;
};

/**
 * Whether a source file belongs to the project: under the root, outside `node_modules`, matched by an include
 * pattern, and neither it nor a directory above it matched by an exclude pattern. Extraction and the watcher both
 * decide membership here.
 *
 * @param config - The project config.
 * @param file - An absolute path.
 * @returns `true` when the file is a project source.
 */
export function isProjectSource(config: ProjectConfig, file: string): boolean {
  return isProjectPath(config, relative(config.root, file).split(sep).join("/"));
}

// `isProjectSource` on a root-relative, `/`-separated path: what the scan decides membership on, whatever the host's
// path rules.
function isProjectPath(config: ProjectConfig, path: string): boolean {
  const segments = path.split("/");
  // Directories as `dir/`: the form that matches `src/skip`, `src/skip/` and `src/skip/**` alike, like globSync's
  // exclude, which prunes a matching directory during the walk.
  const candidates = [
    path,
    ...segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`),
  ];

  return (
    !path.startsWith("../") &&
    !isAbsolute(path) &&
    !segments.includes("node_modules") &&
    config.include.some((pattern) => matchesGlob(path, pattern)) &&
    !candidates.some((candidate) => config.exclude.some((pattern) => matchesGlob(candidate, pattern)))
  );
}

/**
 * Whether a directory holds no project source: it is or lies in `node_modules`, or the config excludes it (as
 * `isProjectSource` and the extract walk prune it).
 *
 * @param config - The project config.
 * @param directory - An absolute directory path.
 * @returns `true` when nothing under the directory can be a project source.
 */
export function isExcludedDirectory(config: ProjectConfig, directory: string): boolean {
  const path = relative(config.root, directory).split(sep).join("/");
  const segments = path.split("/");
  const candidates = segments.map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);

  return (
    segments.includes("node_modules") ||
    candidates.some((candidate) => config.exclude.some((pattern) => matchesGlob(candidate, pattern)))
  );
}

/** What a scan found: the messages, or every extraction problem; either way, the source files it read. */
export type ScanResult =
  | {
      readonly _tag: "Scanned";
      readonly messages: ReadonlyArray<ProjectMessage>;
      /** `IncludeUnmatched` problems: `check` reports them, `extract` refuses to write. */
      readonly unmatched: ReadonlyArray<Problem>;
      /** Each source file read, as its path joined to the root: what a host watches for the next run. */
      readonly sources: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Failed";
      readonly problems: ReadonlyArray<Problem>;
      /** Each source file read, as its path joined to the root: a repair of any of them can clear the problems. */
      readonly sources: ReadonlyArray<string>;
    };

// Whether a path names a file, following links. Absent (as `statSync` with `throwIfNoEntry: false` reads ENOENT and
// ENOTDIR) is no file, like a dangling symlink; any other failure (a self-looping link) is the scan's.
const isFile = (
  files: FileSystem.FileSystem,
  path: string
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  files.stat(path).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound" || isErrno(error.reason.cause, "ENOTDIR"),
      () => Effect.succeed(false)
    )
  );

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/**
 * Extract every message of the project's sources, reusing the runtime's parse cache for the project.
 *
 * @param config - The project config.
 * @returns The messages by key (in first-seen order) and the include patterns that match no file, or every
 *   extraction problem, with the source files read; fails with `ProjectIoFailed` on I/O the scan does not classify.
 */
export const scanProject = /* @__PURE__ */ Effect.fn("elmera-intl.scan")(function* (config: ProjectConfig) {
  const files = yield* FileSystem.FileSystem;
  const discovery = yield* SourceDiscovery;
  const paths = yield* Path.Path;
  const cache = (yield* SourceCaches).of(config.root);
  // Per pattern, so a pattern that stopped matching (a renamed directory) is reported instead of its messages
  // silently leaving the catalogs. glob's `exclude` only prunes the walk (it skips what isProjectSource rejects);
  // isProjectSource decides. The walk also returns directories (a folder named `x.tsx`). It is the host's
  // `SourceDiscovery`; each match's stat and read go through `FileSystem`.
  const matches: Array<{ readonly pattern: string; readonly files: ReadonlyArray<string> }> = [];
  for (const pattern of config.include) {
    const globbed = yield* discovery.find(config.root, pattern, ["**/node_modules/**", ...config.exclude]);
    const sources: Array<string> = [];
    for (const file of globbed) {
      // The name as discovered for every file-system operation, joined by the supplied `Path`; membership on its
      // root-relative path, `/`-separated by that `Path`'s own separator only (on POSIX a backslash is part of a name).
      const absolute = paths.join(config.root, file);

      if (
        isProjectPath(config, paths.relative(config.root, absolute).split(paths.sep).join("/")) &&
        (yield* isFile(files, absolute).pipe(Effect.mapError(platformFailed("scan"))))
      ) {
        sources.push(file);
      }
    }
    matches.push({ pattern, files: sources });
  }
  const unmatched = matches
    .filter((match) => match.files.length === 0)
    .map(({ pattern }) => ({
      code: "IncludeUnmatched",
      message: `include pattern ${JSON.stringify(pattern)} matches no file`,
      fix: `fix or remove the pattern in ${CONFIG_FILE}`,
      file: CONFIG_FILE,
    }));
  const sources = [...new Set(matches.flatMap((match) => match.files))].toSorted();
  const problems: Array<Problem> = [];
  const byKey = new Map<
    string,
    { source: string; context: string | undefined; references: Set<string>; comments: Set<string> }
  >();
  const scannedPaths = new Set<string>();
  const read: Array<string> = [];
  for (const file of sources) {
    // The catalogs' reference, spelled as it always was: `/` for every backslash, on any host.
    const absolute = paths.join(config.root, file);
    read.push(absolute);
    const path = paths.relative(config.root, absolute).split("\\").join("/");
    scannedPaths.add(path);
    const text = yield* readText(files, absolute).pipe(Effect.mapError(platformFailed("scan")));
    const result = cachedExtract(cache, path, text);

    if (result._tag === "Failed") {
      problems.push(
        ...result.failures.map((failure) => ({
          code: "ExtractFailed",
          message: failure.message,
          fix: "rewrite the call in an allowed form (see the extraction contract in @elmeragroup/intl's README)",
          file: path,
          line: failure.position.line,
          column: failure.position.column,
        }))
      );
      continue;
    }

    for (const message of result.messages) {
      if (message.source === "") {
        problems.push({
          code: "EmptyMessage",
          message: "empty message (an empty msgid would collide with the PO header)",
          fix: "give the message text, or remove the call",
          file: path,
        });
        continue;
      }

      const entry = byKey.get(message.key) ?? {
        source: message.source,
        context: message.context,
        references: new Set<string>(),
        comments: new Set<string>(),
      };
      entry.references.add(path);
      message.tags.forEach((tag) => entry.comments.add(tag));
      byKey.set(message.key, entry);
    }
  }

  for (const path of cache.keys()) {
    if (!scannedPaths.has(path)) {
      cache.delete(path);
    }
  }

  if (problems.length > 0) {
    return { _tag: "Failed", problems: [...unmatched, ...problems], sources: read } satisfies ScanResult;
  }

  const messages = [...byKey].map(([key, entry]) => ({
    key,
    source: entry.source,
    context: entry.context,
    references: [...entry.references].toSorted(),
    comments: [...entry.comments].toSorted(),
  }));

  return { _tag: "Scanned", messages, unmatched, sources: read } satisfies ScanResult;
});

function cachedExtract(cache: ParseCache, path: string, text: string): ReturnType<typeof extractMessages> {
  const hash = createHash("sha1").update(text).digest("base64");
  const hit = cache.get(path);

  if (hit?.hash === hash) {
    return hit.result;
  }

  const result = extractMessages(path, text);
  cache.set(path, { hash, result });

  return result;
}
