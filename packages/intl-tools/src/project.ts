// A project the CLI works on: its sources and the messages they declare (project-config.ts reads its config,
// project-catalogs.ts places its catalogs, project-formats.ts loads its formats).
import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";

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
  const path = relative(config.root, file).split(sep).join("/");
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

/**
 * Extract every message of the project's sources.
 *
 * @param config - The project config.
 * @param cache - Parse results from earlier scans; updated in place.
 * @returns The messages by key (in first-seen order) and the include patterns that match no file, or every
 * extraction problem.
 */
export function scanProject(
  config: ProjectConfig,
  cache: ParseCache = new Map()
):
  | {
      readonly _tag: "Scanned";
      readonly messages: ReadonlyArray<ProjectMessage>;
      /** `IncludeUnmatched` problems: `check` reports them, `extract` refuses to write. */
      readonly unmatched: ReadonlyArray<Problem>;
    }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> } {
  // Per pattern, so a pattern that stopped matching (a renamed directory) is reported instead of its messages
  // silently leaving the catalogs. glob's `exclude` only prunes the walk (it skips what isProjectSource rejects);
  // isProjectSource decides. globSync also returns directories (a folder named `x.tsx`).
  const matches = config.include.map((pattern) => ({
    pattern,
    files: globSync(pattern, { cwd: config.root, exclude: ["**/node_modules/**", ...config.exclude] }).filter(
      (file) =>
        isProjectSource(config, join(config.root, file)) &&
        // A dangling symlink has no stat: skip it like a directory.
        statSync(join(config.root, file), { throwIfNoEntry: false })?.isFile() === true
    ),
  }));
  const unmatched = matches
    .filter(({ files }) => files.length === 0)
    .map(({ pattern }) => ({
      code: "IncludeUnmatched",
      message: `include pattern ${JSON.stringify(pattern)} matches no file`,
      fix: `fix or remove the pattern in ${CONFIG_FILE}`,
      file: CONFIG_FILE,
    }));
  const files = [...new Set(matches.flatMap((match) => match.files))].toSorted();
  const problems: Array<Problem> = [];
  const byKey = new Map<
    string,
    { source: string; context: string | undefined; references: Set<string>; comments: Set<string> }
  >();
  const scannedPaths = new Set<string>();
  for (const file of files) {
    const path = relative(config.root, join(config.root, file)).split("\\").join("/");
    scannedPaths.add(path);
    const result = cachedExtract(cache, path, readFileSync(join(config.root, file), "utf8"));

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
    return { _tag: "Failed", problems: [...unmatched, ...problems] };
  }

  const messages = [...byKey].map(([key, entry]) => ({
    key,
    source: entry.source,
    context: entry.context,
    references: [...entry.references].toSorted(),
    comments: [...entry.comments].toSorted(),
  }));

  return { _tag: "Scanned", messages, unmatched };
}

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
