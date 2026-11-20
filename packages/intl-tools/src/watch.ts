// `extract --watch`: one debounced, add-only sync per burst of source or catalog changes. Add-only so a file saved
// mid-edit or a branch switch never drops a translation; explicit `extract` removes unused entries.
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, sep } from "node:path";

import { extractCatalogs } from "./commands";
import type { ParseCache, Problem, ProjectConfig } from "./project";
import { catalogPath, isProjectSource } from "./project";

/** What one sync did. */
export type SyncResult =
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Unchanged" }
  /** A catalog was saved during the sync, so it wrote nothing; another sync follows. */
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> };

/** A running watch. */
export type ProjectWatcher = {
  /** Stop watching; a pending sync is dropped. */
  readonly close: () => Promise<void>;
};

// Long enough to fold a branch switch or a formatter's multi-file save into one sync.
const DEBOUNCE_MS = 100;
const GLOB_CHARS = /[*?[{]/;
const NODE_MODULES = "**/node_modules/**";

/**
 * Sync the catalogs now, then after every change to a source file the config includes or to a catalog. Syncs add
 * messages and references and never remove an entry or a translation; a sync that finds a problem writes nothing.
 * The catalogs it writes do not trigger another sync.
 *
 * @param config - The project config.
 * @param report - Called with each sync's result, the first before this returns.
 * @param extract - One sync's extract; a test wraps it to save an edit after its writes, inside one synchronous call.
 * @returns The running watch.
 */
export function watchProject(
  config: ProjectConfig,
  report: (result: SyncResult) => void,
  extract: typeof extractCatalogs = extractCatalogs
): ProjectWatcher {
  const cache: ParseCache = new Map();
  const catalogs = new Set(config.locales.map((locale) => catalogPath(config, locale)));
  const includeRoots = includePrefixes(config);
  // The text this watch last wrote to each catalog: an event that finds it unchanged is our own write.
  const written = new Map<string, string>();
  let pending: NodeJS.Timeout | undefined;

  // Runs from a timer, where a throw would end the host (the dev server): I/O the extractor does not classify, such as
  // a file a checkout deletes mid-scan, is reported and the next change retries.
  const sync = () => {
    pending = undefined;
    try {
      const result = extract(config, { unused: "keep", cache, concurrentSave: "yield" });
      result.written.forEach(({ path, text }) => {
        written.set(path, text);
      });

      // Not left to the save's own event: a save back to text this watch wrote reads as our own write, and the change
      // that started this sync would be lost.
      if (result.superseded) {
        clearTimeout(pending);
        pending = setTimeout(sync, DEBOUNCE_MS);
      }

      report(
        result.problems.length > 0
          ? { _tag: "Failed", problems: result.problems }
          : result.superseded
            ? { _tag: "Superseded" }
            : result.written.length > 0
              ? { _tag: "Written", files: result.written.map(({ path }) => path) }
              : { _tag: "Unchanged" }
      );
    } catch (error) {
      report({
        _tag: "Failed",
        problems: [
          {
            code: "SyncFailed",
            message: error instanceof Error ? error.message : String(error),
            fix: "fix the file the error names; the next change retries",
          },
        ],
      });
    }
  };

  const triggers = (absolute: string): boolean => {
    if (catalogs.has(absolute)) {
      const ours = written.get(absolute);

      return ours === undefined || readText(absolute) !== ours;
    }

    return isProjectSource(config, absolute);
  };

  // Moving a directory reports only the directory, whose path no include glob matches, so a rename of a directory
  // (or of a path now gone) under an include root rescans.
  const movesTree = (absolute: string): boolean =>
    includeRoots.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}${sep}`)) &&
    isDirectoryOrGone(absolute);

  const watchers = watchRoots(includeRoots, [...catalogs]).map((dir) =>
    watch(dir, { recursive: true, ignore: NODE_MODULES }, (event, filename) => {
      // No filename: the platform could not say what changed, so anything may have.
      if (
        filename === null ||
        triggers(join(dir, filename)) ||
        (event === "rename" && movesTree(join(dir, filename)))
      ) {
        clearTimeout(pending);
        pending = setTimeout(sync, DEBOUNCE_MS);
      }
    }).on("error", (error) => {
      report({
        _tag: "Failed",
        problems: [
          {
            code: "WatchFailed",
            message: `stopped watching ${dir}: ${error.message}`,
            fix: "restart `elmera-intl extract --watch`",
          },
        ],
      });
    })
  );
  sync();

  return {
    close: () => {
      clearTimeout(pending);
      watchers.forEach((watcher) => {
        watcher.close();
      });

      return Promise.resolve();
    },
  };
}

// Each include pattern's static prefix: the directory its matches live under.
function includePrefixes(config: ProjectConfig): Array<string> {
  return config.include.map((pattern) => {
    const segments = pattern.split("/");
    const glob = segments.findIndex((segment) => GLOB_CHARS.test(segment));

    return join(config.root, ...(glob === -1 ? segments.slice(0, -1) : segments.slice(0, glob)));
  });
}

// Each include root and each catalog's directory (the nearest existing ancestor of either), minus any inside another:
// one recursive watch per tree.
function watchRoots(includeRoots: ReadonlyArray<string>, catalogs: ReadonlyArray<string>): Array<string> {
  const dirs = [...includeRoots, ...catalogs.map((path) => dirname(path))].map((dir) => nearestExisting(dir));

  return [...new Set(dirs)]
    .toSorted()
    .filter((dir, _index, all) => !all.some((other) => other !== dir && dir.startsWith(`${other}${sep}`)));
}

// A catalog deleted or replaced by a directory reads as changed.
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Runs in a watch callback, where a throw would end the host: a path that cannot be read counts as gone.
function isDirectoryOrGone(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? true;
  } catch {
    return true;
  }
}

/**
 * The path itself when it exists, else its nearest existing ancestor.
 *
 * @param dir - An absolute path.
 * @returns An existing absolute path.
 */
export function nearestExisting(dir: string): string {
  const parent = dirname(dir);

  return existsSync(dir) || parent === dir ? dir : nearestExisting(parent);
}
