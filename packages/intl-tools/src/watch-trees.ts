// The watch's trees: which directories it watches, and how their changes are delivered, as native file events or as
// polled walks. Each delivery is handed to the watch's `admit` as it happens (see `watch.ts`).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { BigIntStats } from "node:fs";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE } from "./project-config";

const GLOB_CHARS = /[*?[{]/u;
const NODE_MODULES = "**/node_modules/**";

/** The kind of a file event: a path that appeared or went away, or a file whose content changed. */
export type ChangeEvent = "rename" | "change";

/** Where one tree's file events go. */
export type TreeListener = {
  /** A path under the tree changed; `filename` is relative to the tree, or null when the platform could not say. */
  readonly change: (event: ChangeEvent, filename: string | null) => void;
  /** The tree is no longer watched. */
  readonly error: (error: Error) => void;
};

/**
 * The platform's recursive file events for one tree: what a native watch listens to. A service so a host can feed
 * its own watcher's events, and so a test can deliver an event, or an error, at a moment it chooses.
 */
export class FileEvents
  extends /* @__PURE__ */ Context.Service<
    FileEvents,
    {
      /**
       * Listen to `dir`'s tree, from when this returns until the scope closes. A listener's calls are synchronous,
       * from the event loop.
       */
      readonly watch: (dir: string, listener: TreeListener) => Effect.Effect<void, never, Scope.Scope>;
    }
  >()("elmera-intl-tools/FileEvents")
{
  /**
   * Node's recursive `fs.watch`, node_modules ignored.
   *
   * @returns A layer whose watch opens an `fs.watch` in the scope (its start failure a defect) and closes it as the
   *   scope closes.
   */
  static layer(): Layer.Layer<FileEvents> {
    return Layer.succeed(FileEvents, {
      watch: Effect.fn("FileEvents.watch")(function* (dir: string, listener: TreeListener) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(dir, { recursive: true, ignore: NODE_MODULES }, listener.change).on("error", listener.error)
          ),
          (watcher) =>
            Effect.sync(() => {
              watcher.close();
            })
        );
      }),
    });
  }
}

/** A change seen in a watched tree; no path when the platform could not say what changed, so anything may have. */
export type Change = { readonly event: ChangeEvent; readonly path: string | null };

/**
 * What a tree delivers, per native event or per poll walk: the problems that leave part of the project unwatched,
 * and the changes. The watch admits each whole, or from its stop on not at all.
 */
export type Intake = { readonly problems: ReadonlyArray<Problem>; readonly changes: ReadonlyArray<Change> };

/**
 * Listen to every tree's native file events, in the current scope: each tree's listener opens here, in order (a start
 * failure is a defect, the ones already open closing with the scope), and closes as the scope closes, so closing it
 * ends every event at once. Each event is handed to `admit` as it is delivered. A listener's error leaves its tree
 * unwatched.
 *
 * @param dirs - The trees.
 * @param admit - Takes each delivery.
 * @returns An effect that opens the listeners in its scope.
 */
export const listenNative = /* @__PURE__ */ Effect.fnUntraced(function* (
  dirs: ReadonlyArray<string>,
  admit: (item: Intake) => void
) {
  const fileEvents = yield* FileEvents;
  yield* Effect.forEach(
    dirs,
    (dir) =>
      fileEvents.watch(dir, {
        change: (event, filename) => {
          admit({ problems: [], changes: [{ event, path: filename === null ? null : join(dir, filename) }] });
        },
        error: (error) => {
          admit({
            problems: [
              {
                code: "WatchFailed",
                message: `stopped watching ${dir}: ${error.message}`,
                fix: "restart `elmera-intl extract --watch`",
              },
            ],
            changes: [],
          });
        },
      }),
    { discard: true }
  );
});

/**
 * Poll every tree, in the current scope: each tree's first walk is taken here, before the caller goes on (its first
 * sync), so no edit after it is missed, and the directories those walks cannot read are one item handed to `admit`.
 * Then each tree walks every `intervalMs` from its own first walk, on the monotonic clock (a wall-clock step moves no
 * walk), in a fiber of the scope: a walk that runs late, behind a slow first sync or another tree's slow walk, does not
 * move the next one, ticks missed meanwhile are skipped rather than piled up, and a tree's walks never overlap. A
 * walk's changes and the directories it newly cannot read are one item, handed to `admit` as the walk ends. Closing
 * the scope ends every walk; a walk's defect is the `supervised` wrapper's to handle.
 *
 * @param dirs - The trees.
 * @param intervalMs - Milliseconds between a tree's walks.
 * @param prune - Whether a directory is left unwalked.
 * @param admit - Takes the first walks' item, then each later walk's.
 * @param supervised - Wraps each tree's walking fiber, so its defect reaches the watch.
 * @returns An effect that takes the first walks and starts the later ones in its scope.
 */
export const startPolling = /* @__PURE__ */ Effect.fnUntraced(function* (
  dirs: ReadonlyArray<string>,
  intervalMs: number,
  prune: (directory: string) => boolean,
  admit: (item: Intake) => void,
  supervised: (walking: Effect.Effect<void>) => Effect.Effect<void>
) {
  const clock = yield* Clock.Clock;
  const interval = BigInt(intervalMs) * 1_000_000n;
  const trees = dirs.map((dir) => ({
    dir,
    first: snapshot(dir, prune),
    walked: clock.monotonicTimeNanosUnsafe(),
  }));
  admit({ problems: trees.flatMap(({ first }) => newlyUnreadable(first, undefined)), changes: [] });

  for (const { dir, first, walked } of trees) {
    let previous = first;
    let due = walked + interval;
    // Waits for the tree's next tick, then times the one after it from its own cadence.
    const tick = Effect.gen(function* () {
      const now = clock.monotonicTimeNanosUnsafe();

      if (now < due) {
        yield* Effect.sleep(Duration.nanos(due - now));
      }

      const woke = clock.monotonicTimeNanosUnsafe();
      due += interval * ((woke > due ? (woke - due) / interval : 0n) + 1n);
    });
    const walk = Effect.sync(() => {
      const current = snapshot(dir, prune);
      const before = previous;
      previous = current;
      admit({ problems: newlyUnreadable(current, before), changes: changes(dir, before, current) });
    });
    yield* Effect.forkScoped(supervised(Effect.forever(tick.pipe(Effect.andThen(walk)))));
  }
});

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

// What moved between two walks of a tree, shaped as the native events: "rename" for a path that appeared or went away
// (a moved directory included), "change" for a file whose stamp moved.
function changes(dir: string, previous: Snapshot, current: Snapshot): ReadonlyArray<Change> {
  const moved: Array<Change> = [];

  for (const [name, entry] of current.entries) {
    const before = previous.entries.get(name);

    if (before === undefined || before.directory !== entry.directory) {
      moved.push({ event: "rename", path: join(dir, name) });
    } else if (before.stamp !== entry.stamp) {
      moved.push({ event: "change", path: join(dir, name) });
    }
  }

  for (const name of previous.entries.keys()) {
    if (!current.entries.has(name)) {
      moved.push({ event: "rename", path: join(dir, name) });
    }
  }

  return moved;
}

// The directories a walk could not read that the walk before it could.
function newlyUnreadable(current: Snapshot, before: Snapshot | undefined): ReadonlyArray<Problem> {
  return [...current.unreadable]
    .filter(([directory]) => before?.unreadable.has(directory) !== true)
    .map(([directory, error]) => ({
      code: "WatchFailed",
      message: `cannot read ${directory} (${error.message}), so changes under it are not seen`,
      fix: `make it readable, or exclude it in ${CONFIG_FILE}; the rest of the project is still watched`,
    }));
}

/**
 * Each include pattern's static prefix: the directory its matches live under.
 *
 * @param config - The project config.
 * @returns One absolute directory per include pattern.
 */
export function includePrefixes(config: ProjectConfig): Array<string> {
  return config.include.map((pattern) => {
    const segments = pattern.split("/");
    const glob = segments.findIndex((segment) => GLOB_CHARS.test(segment));

    return join(config.root, ...(glob === -1 ? segments.slice(0, -1) : segments.slice(0, glob)));
  });
}

/**
 * The trees to watch: each include root and each catalog's directory (the nearest existing ancestor of either), minus
 * any inside another, so one recursive watch covers each tree.
 *
 * @param includeRoots - The include patterns' prefixes.
 * @param catalogs - The catalogs' paths.
 * @returns The trees' roots, sorted.
 */
export function watchRoots(
  includeRoots: ReadonlyArray<string>,
  catalogs: ReadonlyArray<string>
): Array<string> {
  const dirs = [...includeRoots, ...catalogs.map((path) => dirname(path))].map((dir) => nearestExisting(dir));

  return [...new Set(dirs)]
    .toSorted()
    .filter((dir, _index, all) => !all.some((other) => other !== dir && dir.startsWith(`${other}${sep}`)));
}

/**
 * Whether a renamed path under an include root moved a tree: moving a directory reports only the directory, whose
 * path no include glob matches. Called from a watch's delivery, where a throw would end the host: a path that cannot
 * be read counts as gone.
 *
 * @param includeRoots - The include patterns' prefixes.
 * @param absolute - The renamed path.
 * @returns Whether the path is under an include root and is now a directory or gone.
 */
export function movesTree(includeRoots: ReadonlyArray<string>, absolute: string): boolean {
  if (!includeRoots.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}${sep}`))) {
    return false;
  }

  try {
    return statSync(absolute, { throwIfNoEntry: false })?.isDirectory() ?? true;
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
