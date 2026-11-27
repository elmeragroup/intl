// The watch's trees: which directories it watches, and how their changes are delivered, as native file events or as
// polled walks. Each delivery is handed to the watch's `admit` as it happens (see `watch.ts`).
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { BigIntStats } from "node:fs";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import type { Problem } from "./problem";
import { fileIdentity, realPath } from "./project-catalogs";
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
 * The platform's file events for one tree, its whole depth or one directory's own entries: what a native watch listens
 * to. A service so a host can feed its own watcher's events, and so a test can deliver an event, or an error, at a
 * moment it chooses.
 */
export class FileEvents
  extends /* @__PURE__ */ Context.Service<
    FileEvents,
    {
      /**
       * Listen to `dir`'s tree, from when this returns until the scope closes: every depth when `recursive`, else
       * only the entries directly in `dir`. A listener's calls are synchronous, from the event loop.
       */
      readonly watch: (
        dir: string,
        listener: TreeListener,
        recursive: boolean
      ) => Effect.Effect<void, never, Scope.Scope>;
    }
  >()("elmera-intl-tools/FileEvents")
{
  /**
   * Node's `fs.watch`, node_modules ignored.
   *
   * @returns A layer whose watch opens an `fs.watch` in the scope (its start failure a defect) and closes it as the
   *   scope closes.
   */
  static layer(): Layer.Layer<FileEvents> {
    return Layer.succeed(FileEvents, {
      watch: Effect.fn("FileEvents.watch")(function* (
        dir: string,
        listener: TreeListener,
        recursive: boolean
      ) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(dir, { recursive, ignore: NODE_MODULES }, listener.change).on("error", listener.error)
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
 * ends every event at once. Then each of `besides`' directories, its own entries only and best-effort: one whose watch
 * fails as it starts (a directory that lets a file in it be opened by name but denies listing) is left unwatched, with
 * no problem, and the trees still see what they would without it. Each event is handed to `admit` as it is delivered.
 * A listener's error leaves its tree unwatched.
 *
 * @param dirs - The trees, each watched at every depth.
 * @param besides - Directories watched for their own entries, if they can be (`catalogTargets`).
 * @param admit - Takes each delivery.
 * @returns An effect that opens the listeners in its scope.
 */
export const listenNative = /* @__PURE__ */ Effect.fnUntraced(function* (
  dirs: ReadonlyArray<string>,
  besides: ReadonlyArray<string>,
  admit: (item: Intake) => void
) {
  const fileEvents = yield* FileEvents;
  const listen = (dir: string, recursive: boolean) =>
    fileEvents.watch(
      dir,
      {
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
      },
      recursive
    );
  yield* Effect.forEach(dirs, (dir) => listen(dir, true), { discard: true });
  yield* Effect.forEach(besides, (dir) => listen(dir, false).pipe(Effect.catchDefect(() => Effect.void)), {
    discard: true,
  });
});

// A full turn of the event loop: two `setImmediate` turns, since one check-phase turn passes neither the timers nor the
// I/O poll phase that came before it in the same loop iteration, and two always span every phase once, whichever phase
// the walk ended in. Its own `setImmediate`, not Effect's yield, whose scheduling Effect does not promise; cleared on
// interruption.
const loopTurn: Effect.Effect<void> = /* @__PURE__ */ Effect.callback<void>((resume) => {
  let pending = setImmediate(() => {
    pending = setImmediate(() => {
      resume(Effect.void);
    });
  });

  return Effect.sync(() => {
    clearImmediate(pending);
  });
});

/**
 * What a poll waits on between one tree's walk and the next, so the host's timers and I/O run before the next walk: a
 * full turn of the event loop. A reference, so a watch on the test clock, which waits for no real `setImmediate`
 * before it moves on, can wait on a turn of Effect's own scheduler instead.
 */
export const BetweenWalks = /* @__PURE__ */ Context.Reference<Effect.Effect<void>>(
  "elmera-intl-tools/BetweenWalks",
  {
    defaultValue: () => loopTurn,
  }
);

/**
 * Poll every tree, in the current scope: each tree's first walk is taken here, before the caller goes on (its first
 * sync), so no edit after it is missed, and the directories those walks cannot read are one item handed to `admit`.
 * Then one fiber of the scope walks every tree again, in order (a round), but not before `firstSynced` has completed: a
 * walk is synchronous and holds the event loop, so walks during the first sync would take the turns its I/O needs, and
 * once a walk took longer than the interval the start would barely advance (#82). The first later round starts
 * `intervalMs` after the first sync, and each later one `intervalMs` after the previous round ended: a relative sleep,
 * so a wall-clock step moves no walk, the event loop is free for at least an interval between rounds, however long
 * the walks of the trees together take, and no walks overlap. The first sync's result and the ready line are queued
 * before that first interval starts, so a writer that writes them within it does so before the next walk. In the later
 * rounds, between one tree's walk and the next, the poll waits on `BetweenWalks`, a full turn of the event loop, so the
 * host's timers and I/O run between them (the first walks run back to back). A start therefore costs one round plus
 * the first sync, whatever the interval; a save made during the first sync is delivered by the round one interval
 * after it.
 *
 * The bound on noticing a change, once the first sync has completed: a change is delivered by the next round to start,
 * at most `intervalMs` after the round in progress at the change ends (or, between rounds, after the last one ended,
 * the first sync's completion included), so within one interval plus two rounds of the change, as far as the event
 * loop is free to wake the poll. Each walk's changes and the directories it newly cannot read are one item, handed to
 * `admit` as that tree's walk ends. Closing the scope ends every walk; a walk's defect is the `supervised` wrapper's to
 * handle.
 *
 * @param dirs - The trees.
 * @param intervalMs - Milliseconds from the end of a round of walks (or of the first sync) to the start of the next.
 * @param prune - Whether a directory is left unwalked.
 * @param admit - Takes the first walks' item, then each later walk's.
 * @param supervised - Wraps the fiber that walks the rounds, so a walk's defect reaches the watch.
 * @param firstSynced - Completes when the first sync has run; no round after the first starts until an interval after.
 * @returns An effect that takes the first walks and starts the later rounds in its scope.
 */
export const startPolling = /* @__PURE__ */ Effect.fnUntraced(function* (
  dirs: ReadonlyArray<string>,
  intervalMs: number,
  prune: (directory: string) => boolean,
  admit: (item: Intake) => void,
  supervised: (walking: Effect.Effect<void>) => Effect.Effect<void>,
  firstSynced: Effect.Effect<void>
) {
  const betweenWalks = yield* BetweenWalks;
  const trees = dirs.map((dir) => ({ dir, previous: snapshot(dir, prune) }));
  admit({ problems: trees.flatMap(({ previous }) => newlyUnreadable(previous, undefined)), changes: [] });
  // Every tree in order, an event-loop turn between two walks; each walk's changes handed over as it ends.
  const round = Effect.gen(function* () {
    for (const [index, tree] of trees.entries()) {
      if (index > 0) {
        yield* betweenWalks;
      }

      const current = snapshot(tree.dir, prune);
      const before = tree.previous;
      tree.previous = current;
      admit({ problems: newlyUnreadable(current, before), changes: changes(tree.dir, before, current) });
    }
  });
  // The sleep follows the round's last hand-over, so the time the walks and their changes take never comes out of it.
  const later = Effect.forever(Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.andThen(round)));
  yield* Effect.forkScoped(supervised(firstSynced.pipe(Effect.andThen(later))));
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
 * A catalog's path as the trees' changes name it, for choosing and walking the trees: as spelled, unless a segment is
 * `..`, then at its directory's real path. Both modes name a change as the tree's root joined with a name relative to
 * it, and `join` collapses a `..` in the root lexically, while the watcher and the walk read the directory the kernel
 * climbs to: a tree rooted at `messages/jump/..`, with `jump -> ../other/sub`, reads `other` and names its `nb.po`
 * `messages/nb.po`, another file. A link or another case in the spelling survives the join, and the change names the
 * catalog as spelled.
 *
 * @param catalog - The catalog's path, absolute, as `catalogPath` spells it.
 * @returns The path the trees name it by.
 */
export function treePath(catalog: string): string {
  return catalog.split(sep).includes("..") ? join(realPath(dirname(catalog)), basename(catalog)) : catalog;
}

/**
 * The directories a native watch adds beside the trees, for its own entries only (`listenNative`'s `besides`): each
 * catalog that is a file link to another directory (`messages/nb.po -> ../translations/nb.po`) has its target's, since
 * an editor's save to the target raises its native event only there, while the link's own directory, a tree, sees a
 * repoint of the link. Not one whose identity (`fileIdentity`) lies in a tree's, which delivers its events already. A
 * poll needs none: it reads the target through the link.
 *
 * @param roots - The trees (`watchRoots`).
 * @param catalogs - The catalogs' paths, as the trees name them (`treePath`).
 * @returns The directories, sorted.
 */
export function catalogTargets(roots: ReadonlyArray<string>, catalogs: ReadonlyArray<string>): Array<string> {
  const trees = roots.map((root) => fileIdentity(root));
  const targets = catalogs
    .map((catalog) => ({ link: realPath(dirname(catalog)), target: dirname(realPath(catalog)) }))
    .filter(({ link, target }) => target !== link)
    .map(({ target }) => target);

  return [...new Set(targets)].toSorted().filter((dir) => {
    const identity = fileIdentity(dir);

    return !trees.some((tree) => identity === tree || identity.startsWith(`${tree}${sep}`));
  });
}

/**
 * The trees to watch: each include root and each catalog's directory (the nearest existing ancestor of either), minus
 * any another covers, so one recursive watch covers each tree. A tree is covered by another only when it lies inside it
 * as spelled and no link lies between them, its identity (`fileIdentity`) the other's joined with the path between: a
 * recursive native watch does not follow a link, so `src` delivers no event for a save under `src/linked -> ../feature`.
 *
 * @param includeRoots - The include patterns' prefixes.
 * @param catalogs - The catalogs' paths, as the trees name them (`treePath`).
 * @returns The trees' roots, sorted.
 */
export function watchRoots(
  includeRoots: ReadonlyArray<string>,
  catalogs: ReadonlyArray<string>
): Array<string> {
  const dirs = [...includeRoots, ...catalogs.map((path) => dirname(path))].map((dir) => nearestExisting(dir));
  const identities = new Map([...new Set(dirs)].map((dir) => [dir, fileIdentity(dir)]));
  const covers = (other: string, dir: string) =>
    other !== dir &&
    dir.startsWith(`${other}${sep}`) &&
    identities.get(dir) === join(identities.get(other) ?? other, relative(other, dir));

  return [...identities.keys()]
    .toSorted()
    .filter((dir, _index, all) => !all.some((other) => covers(other, dir)));
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
