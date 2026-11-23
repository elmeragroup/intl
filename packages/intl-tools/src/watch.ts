// `extract --watch`: one debounced, add-only sync per burst of source or catalog changes. Add-only so a file saved
// mid-edit or a branch switch never drops a translation; explicit `extract` removes unused entries.
import type { BigIntStats } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { extractCatalogs } from "./commands";
import type { Problem } from "./problem";
import type { ParseCache } from "./project";
import { catalogPath, isExcludedDirectory, isProjectSource } from "./project";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE } from "./project-config";

/** What one sync did. */
export type SyncResult =
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Unchanged" }
  /** A catalog was saved during the sync, so it wrote nothing; another sync follows. */
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> };

/**
 * A sync that threw, I/O the extractor does not classify or a report that could not be written, as the result the
 * watch reports in its place.
 *
 * @param message - What the sync threw, as its message.
 * @returns A failed result with one `SyncFailed` problem naming the error.
 */
export function syncFailed(message: string): SyncResult {
  return {
    _tag: "Failed",
    problems: [
      {
        code: "SyncFailed",
        message,
        fix: "fix the file the error names; the next change retries",
      },
    ],
  };
}

/** A running watch. */
export type ProjectWatcher = {
  /** Stop watching; a pending sync is dropped. */
  readonly close: () => Promise<void>;
};

/**
 * Where change events come from. `native` is the platform's file events (`fs.watch`, recursive); `poll` stats every
 * watched file each `intervalMs`, for hosts whose native events arrive late or not at all (a container's bind mount,
 * a network drive, a macOS whose fseventsd is saturated): slower to notice and costlier, but it depends on no event
 * daemon.
 */
export type WatchMode = { readonly _tag: "native" } | { readonly _tag: "poll"; readonly intervalMs: number };

const NATIVE: WatchMode = { _tag: "native" };

/** The shortest poll interval: below it, a walk per tick of a real project is a continuous scan. */
export const MIN_POLL_MS = 10;
/** The longest delay Node's timers keep; a longer one becomes 1 ms. */
export const MAX_POLL_MS = 2_147_483_647;

/** A poll interval out of the range the poller takes. */
export type PollIntervalOutOfRange = { readonly _tag: "PollIntervalOutOfRange"; readonly intervalMs: number };

/**
 * Parse a poll interval into a polling watch mode.
 *
 * @param intervalMs - Milliseconds between walks.
 * @returns The polling mode, or `PollIntervalOutOfRange` for anything but a whole number from 10 to 2147483647.
 */
export function pollEvery(intervalMs: number): WatchMode | PollIntervalOutOfRange {
  return Number.isInteger(intervalMs) && intervalMs >= MIN_POLL_MS && intervalMs <= MAX_POLL_MS
    ? { _tag: "poll", intervalMs }
    : { _tag: "PollIntervalOutOfRange", intervalMs };
}

// Long enough to fold a branch switch or a formatter's multi-file save into one sync.
const DEBOUNCE_MS = 100;
const GLOB_CHARS = /[*?[{]/u;
const NODE_MODULES = "**/node_modules/**";

/**
 * Sync the catalogs now, then after every change to a source file the config includes or to a catalog. Syncs add
 * messages and references and never remove an entry or a translation; a sync that finds a problem writes nothing.
 * The catalogs it writes do not trigger another sync.
 *
 * @param config - The project config.
 * @param report - Called with each sync's result, the first before this returns.
 * @param extract - One sync's extract; a test wraps it to save an edit after its writes, inside one synchronous call.
 * @param mode - Where change events come from; native file events unless the caller polls.
 * @returns The running watch.
 */
export function watchProject(
  config: ProjectConfig,
  report: (result: SyncResult) => void,
  extract: typeof extractCatalogs = extractCatalogs,
  mode: WatchMode = NATIVE
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
      report(syncFailed(error instanceof Error ? error.message : String(error)));
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

  const onChange = (dir: string, event: ChangeEvent, filename: string | null): void => {
    // No filename: the platform could not say what changed, so anything may have.
    if (
      filename === null ||
      triggers(join(dir, filename)) ||
      (event === "rename" && movesTree(join(dir, filename)))
    ) {
      clearTimeout(pending);
      pending = setTimeout(sync, DEBOUNCE_MS);
    }
  };
  const onError = (dir: string, error: Error): void => {
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
  };
  // A directory the config excludes holds no source; one holding a catalog is still walked.
  const prune = (directory: string): boolean =>
    isExcludedDirectory(config, directory) &&
    ![...catalogs].some((catalog) => catalog.startsWith(`${directory}${sep}`));
  const onUnreadable = (directory: string, error: Error): void => {
    report({
      _tag: "Failed",
      problems: [
        {
          code: "WatchFailed",
          message: `cannot read ${directory} (${error.message}), so changes under it are not seen`,
          fix: `make it readable, or exclude it in ${CONFIG_FILE}; the rest of the project is still watched`,
        },
      ],
    });
  };
  const subscriptions = watchRoots(includeRoots, [...catalogs]).map((dir) =>
    mode._tag === "poll"
      ? pollTree(
          dir,
          mode.intervalMs,
          prune,
          (event, filename) => {
            onChange(dir, event, filename);
          },
          onUnreadable
        )
      : nativeTree(
          dir,
          (event, filename) => {
            onChange(dir, event, filename);
          },
          (error) => {
            onError(dir, error);
          }
        )
  );
  sync();

  return {
    close: () => {
      clearTimeout(pending);
      subscriptions.forEach((close) => {
        close();
      });

      return Promise.resolve();
    },
  };
}

type ChangeEvent = "rename" | "change";
type Unsubscribe = () => void;

// The platform's recursive file events for one tree.
function nativeTree(
  dir: string,
  onChange: (event: ChangeEvent, filename: string | null) => void,
  onError: (error: Error) => void
): Unsubscribe {
  const watcher = watch(dir, { recursive: true, ignore: NODE_MODULES }, onChange).on("error", onError);

  return () => {
    watcher.close();
  };
}

// What a poll compares a path by: nanosecond change and modification times and the size, so a rewrite within one
// millisecond still differs.
type Entry = { readonly directory: boolean; readonly stamp: string };

// One walk of a tree: its entries by path relative to the root, and the directories it could not read.
type Snapshot = {
  readonly entries: ReadonlyMap<string, Entry>;
  readonly unreadable: ReadonlyMap<string, Error>;
};

// The tree one level at a time, so a directory `prune` rejects (node_modules, an excluded one) is listed by its parent
// but never read, and one that cannot be read is recorded while the rest of the tree is still walked.
function snapshot(root: string, prune: (directory: string) => boolean): Snapshot {
  const entries = new Map<string, Entry>();
  const unreadable = new Map<string, Error>();
  const pending = [root];

  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let names: ReadonlyArray<string> = [];

    try {
      names = readdirSync(directory, { encoding: "utf8" });
    } catch (error) {
      unreadable.set(directory, error instanceof Error ? error : new Error(String(error)));
    }

    for (const name of names) {
      const path = join(directory, name);
      let stats: BigIntStats | undefined;

      try {
        stats = statSync(path, { bigint: true, throwIfNoEntry: false });
      } catch {
        stats = undefined;
      }

      if (stats === undefined) {
        continue;
      }

      const isDirectory = stats.isDirectory();
      entries.set(relative(root, path), {
        directory: isDirectory,
        stamp: isDirectory ? "" : `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`,
      });

      if (isDirectory && name !== "node_modules" && !prune(path)) {
        pending.push(path);
      }
    }
  }

  return { entries, unreadable };
}

// Polled file events for one tree, shaped as the native ones: "rename" for a path that appeared or went away (a moved
// directory included), "change" for a file whose stamp moved. A directory that becomes unreadable is reported once,
// when it does. The first snapshot is taken here, before the caller's first sync, so no edit after this returns is
// missed.
function pollTree(
  dir: string,
  intervalMs: number,
  prune: (directory: string) => boolean,
  onChange: (event: ChangeEvent, filename: string | null) => void,
  onUnreadable: (directory: string, error: Error) => void
): Unsubscribe {
  const reportNew = (current: Snapshot, before: Snapshot | undefined): void => {
    for (const [directory, error] of current.unreadable) {
      if (before?.unreadable.has(directory) !== true) {
        onUnreadable(directory, error);
      }
    }
  };
  let previous = snapshot(dir, prune);
  reportNew(previous, undefined);
  const timer = setInterval(() => {
    const current = snapshot(dir, prune);

    for (const [name, entry] of current.entries) {
      const before = previous.entries.get(name);

      if (before === undefined || before.directory !== entry.directory) {
        onChange("rename", name);
      } else if (before.stamp !== entry.stamp) {
        onChange("change", name);
      }
    }

    for (const name of previous.entries.keys()) {
      if (!current.entries.has(name)) {
        onChange("rename", name);
      }
    }

    reportNew(current, previous);
    previous = current;
  }, intervalMs);

  return () => {
    clearInterval(timer);
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
