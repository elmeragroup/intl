// One dev server's follow of its project config (#52): which catalog watch runs, restarted on the config as edited.
// It owns the config's last read, the scheduling of follows, the current watch, the watch's shutdown and when open tabs
// are told about the catalogs. The dev plugin (vite-plugins.ts) owns the runtime the watches run on, its disposal and
// the hooks that call this.
import { realpathSync } from "node:fs";
import { relative } from "node:path";

import { describeProblem } from "./problem";
import type { ConfigLoaded, ConfigSnapshot, ProjectConfig } from "./project-config";
import { snapshotConfig } from "./project-config";
import type { ProjectWatcher } from "./watch";

const NAME = "elmera-intl";

/** What a follow needs of its dev server. */
export type FollowedServer = {
  /** The server's root, which the log names the config relative to. */
  readonly root: string;
  /** The server's logger. */
  readonly logger: {
    readonly info: (message: string, options: { readonly timestamp: boolean }) => void;
    readonly error: (message: string) => void;
  };
  /** Has the server's watcher report one file's changes, unless it already covers the file (one under the root). */
  readonly watch: (file: string) => void;
  /** Whether Vite restarts the whole server for a change it reports at `path` (a dependency of its config). */
  readonly restartsFor: (path: string) => boolean;
  /** Invalidates every compiled catalog, whose compile reads the config. */
  readonly invalidate: () => void;
  /** Tells open tabs that the catalogs changed. */
  readonly notify: () => void;
};

/** A dev server's follow of its project config. */
export type ConfigFollow = {
  /**
   * Settles once the server's first watch has settled its start and every follow scheduled by then has run, from the
   * watch selected then: it rejects with that watch's start failure, and otherwise resolves (no watch is selected
   * when the config is invalid or missing, or once a replacement's failed start has been logged).
   */
  readonly started: Promise<void>;
  /**
   * Follows a change the server reported to the config at `reported`, unless Vite restarts the server for it. Settles
   * once the follow it joined has run; never rejects, as each step logs its own failure.
   */
  readonly follow: (reported: string) => Promise<void>;
  /**
   * Whether a PO save's notice to open tabs is held: while a config follow is in flight, from the change until the
   * selected watch's start has settled, a PO save still invalidates its modules but sends nothing, and the follow's
   * end sends the one notice.
   */
  readonly holdsNotice: () => boolean;
  /**
   * Stops following: closes the watch at once, waits for a follow in flight (which starts nothing more), and closes any
   * watch left. The same close for every call; it rejects as the watch's close does.
   */
  readonly close: () => Promise<void>;
};

/**
 * Start a dev server's catalog watch on its project config, and follow the config's edits.
 *
 * The config is added to the server's watcher, and so is its target when it is a link (outside the root, either is
 * reported only once added). The watch starts on the config as read (none, and the problem logged, when it is invalid
 * or missing). Each `follow` that Vite leaves to the plugin schedules one reconcile; one runs at a time, and every
 * `follow` before the next one begins shares it, so the latest config wins. Vite owns a change it restarts the server
 * for: one whose reported path is a dependency of the Vite config, or an edit of the config's current target (its
 * realpath as the last reconcile found it) when that target is one, which Vite also reports by its canonical path. A
 * reconcile, unless the server is closing:
 *
 * - watches the config's new target, when the config is a link that a change repointed (reported as the link changed
 *   or created): a repoint to the same text restarts nothing, but the target's later edits are reported;
 * - reads the config once, and does nothing more when the text is the one the last read found (a save of the same
 *   text; chokidar's report of a link it was asked to watch, which would otherwise restart the watch on every report);
 * - otherwise logs the restart, invalidates the compiled catalogs (a load before the new watch's first sync compiles
 *   with the edited config rather than the old compile: Vite does not invalidate a catalog for a repoint it reports as
 *   created), closes the watch, and starts one on the config parsed from that same read, never a later read of the
 *   file, so the watch always runs on the text the next reconcile compares with.
 *
 * Open tabs are told once per follow, after the last reconcile scheduled has run and its watch has settled its start:
 * the catalogs are invalidated again and one notice goes out, when the watch restarted and its start did not fail (a
 * config that turned invalid is told too: the catalogs compile against it). A failed start is logged and tells nothing.
 * A follow that restarts nothing ends within the reconcile's own steps, none of which waits on I/O, so no PO save's
 * notice can be held across it.
 *
 * @param server - The dev server.
 * @param config - The absolute path of the project config.
 * @param start - Starts a watch on a config, on the server's runtime.
 * @returns The follow.
 */
export function followConfig(
  server: FollowedServer,
  config: string,
  start: (config: ProjectConfig) => ProjectWatcher
): ConfigFollow {
  const { logger, root } = server;
  // Runs one step of a follow. A failure is logged with `failed`; a logger that throws on it too is ignored. Either way
  // the steps after it, and the next follow, still run.
  const attempt = async (failed: string, step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      try {
        logger.error(`${NAME}: ${failed}: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // The logger is the one channel a failure is reported on.
      }
    }
  };

  // The last read of the config, and the target it linked to then.
  let read: ConfigSnapshot = snapshotConfig(config);
  let target = realpathOf(config);
  // The selected watch, if any; and, while it is still the selected one, its start failure.
  let current: ProjectWatcher | undefined;
  let failure: { readonly error: unknown } | undefined;
  // The reconciles, chained (never rejected); whether the last one in the chain has not begun yet; the one close, once
  // it is asked for.
  let reconciles = Promise.resolve();
  let queued = false;
  let closing: Promise<void> | undefined;
  // Whether a follow is in flight, and whether the watch restarted since it began.
  let following = false;
  let restarted = false;
  // Read through a call: a close can be asked for during any await below.
  const isClosing = () => closing !== undefined;

  // Selects the watch on a config as parsed (none, and its problem logged, when it is invalid), and settles once its
  // start has: a failed start, which has stopped the watch and closed its watchers, deselects it and is kept while
  // nothing else was selected meanwhile. The failure is handled here, at once, so a superseded one goes unreported.
  const select = (loaded: ConfigLoaded): Promise<{ readonly error: unknown } | undefined> => {
    current = undefined;
    failure = undefined;
    if (loaded._tag === "ConfigInvalid") {
      void attempt("the config problem was not logged", () => {
        logger.error(describeProblem(loaded.problem));
      });

      return Promise.resolve(undefined);
    }

    const watch = start(loaded.config);
    current = watch;

    return (async () => {
      try {
        await watch.started;

        return undefined;
      } catch (error) {
        if (current === watch) {
          current = undefined;
          failure = { error };
        }

        return { error };
      }
    })();
  };

  const reconcile = async () => {
    // A follow queued before the close starts nothing, and registers nothing with a watcher the close has shut.
    if (isClosing()) {
      return;
    }

    const moved = realpathOf(config);
    if (moved !== undefined && moved !== target) {
      await attempt(`${moved} was not watched`, () => {
        server.watch(moved);
      });
    }
    target = moved;

    const next = snapshotConfig(config);
    if (isClosing() || next.text === read.text) {
      return;
    }

    read = next;
    restarted = true;
    await attempt("the restart was not logged", () => {
      logger.info(`${NAME}: ${relative(root, config)} changed, restarting the catalog watch`, {
        timestamp: true,
      });
    });
    await attempt("the catalogs were not invalidated", server.invalidate);
    const previous = current;
    current = undefined;
    await attempt("the catalog watch did not close", () => previous?.close());

    // A close asked for while the old watch closed starts nothing more.
    if (isClosing()) {
      return;
    }

    await attempt("the catalog watch did not start", async () => {
      const failed = await select(next.loaded);
      if (failed !== undefined) {
        // The next edit of the config starts another.
        throw failed.error;
      }
    });
  };

  // After the last reconcile scheduled: the follow ends, and tells open tabs once, as `followConfig` says.
  const settle = async () => {
    if (queued || isClosing()) {
      return;
    }

    const tells = restarted && failure === undefined;
    following = false;
    restarted = false;
    if (tells) {
      await attempt("the catalogs were not invalidated", server.invalidate);
      await attempt("open tabs were not told", server.notify);
    }
  };

  // Every reconcile scheduled so far, and any scheduled while they ran.
  const drained = async (): Promise<void> => {
    const chain = reconciles;
    await chain;

    if (chain !== reconciles) {
      await drained();
    }
  };

  // The config, and its target when it is a link: the same registration a repoint makes.
  new Set([config, target ?? config]).forEach((path) => {
    server.watch(path);
  });
  const first = select(read.loaded);

  return {
    started: (async () => {
      await first;
      await drained();
      if (failure !== undefined) {
        throw failure.error;
      }
    })(),
    follow: (reported) => {
      // Vite's restart replaces the server, and its replacement reads the config itself.
      const owned =
        server.restartsFor(reported) ||
        (target !== undefined && realpathOf(config) === target && server.restartsFor(target));
      if (isClosing() || owned) {
        return Promise.resolve();
      }

      following = true;
      if (!queued) {
        queued = true;
        reconciles = reconciles.then(async () => {
          queued = false;
          await attempt("the config was not followed", reconcile);
          await settle();
        });
      }

      return reconciles;
    },
    holdsNotice: () => following,
    close: () => {
      closing ??= (async () => {
        const stopping = current?.close();
        await reconciles;
        await Promise.all([stopping, current?.close()]);
      })();

      return closing;
    },
  };
}

// The real path of a file, or none when it cannot be resolved (missing, or a dangling link).
function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
