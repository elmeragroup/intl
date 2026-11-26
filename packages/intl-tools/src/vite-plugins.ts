// The Vite plugins' assembly, over the services their sessions run on: `intl()` (vite.ts) supplies the real ones.
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Environment, Plugin, ResolvedConfig, ViteDevServer } from "vite";

import { CATALOG_UPDATE_EVENT } from "@elmeragroup/intl/internal/catalog";

import { compileCatalogImport } from "./catalog-import";
import { inProcessRun } from "./command-run";
import type { HostSessions } from "./host-sessions";
import { hostSessions } from "./host-sessions";
import { describeProblem } from "./problem";
import { catalogPath } from "./project-catalogs";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { ProjectServices } from "./project-services";
import type { ProjectWatchEnd, ProjectWatcher } from "./project-watcher";
import { watchProject } from "./project-watcher";
import { Reporter } from "./reporter";
import type { SyncResult, WatchMode, WatchServices } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery } from "./watch";
import { nearestExisting } from "./watch-trees";

// chokidar's default interval, which Vite's `server.watch` passes on when polling sets none.
const DEFAULT_POLL_MS = 100;

/** Options for `intl()`. */
export type IntlPluginOptions = {
  /** Path of `elmera-intl.json`, relative to the Vite root; defaults to the root's. */
  readonly config?: string;
};

const NAME = "elmera-intl";

// What each session runs on: the watch's services, and the project's services the build's check runs on.
type PluginServices = WatchServices | ProjectServices;

/**
 * The `intl()` plugins, each session built from `services`: the catalog plugin, the dev server's watch and the
 * build's check.
 *
 * @param options - Where the project config lives.
 * @param services - The services each session runs on, built for it alone.
 * @returns The catalog, dev and build plugins.
 */
export function intlPlugins(
  options: IntlPluginOptions,
  services: Layer.Layer<PluginServices>
): Array<Plugin> {
  const configPath = (root: string) => resolve(root, options.config ?? CONFIG_FILE);
  // Each session builds its own services, so one session's end or failure never touches another's. Each dev server's
  // watch, which owns its services (see `watchProject`), keyed by its resolved config (a restart's replacement has its
  // own) and stored as soon as its start begins, so a server that closes while it is still starting stops it there.
  const servers = new WeakMap<ResolvedConfig, ProjectWatcher>();
  // Each build's runtime, keyed by the environment that builds: a builder with `sharedConfigBuild` shares one
  // top-level config between its environments.
  const buildSessions = hostSessions<Environment, PluginServices>(services);

  return [
    intlCatalogs(options),
    {
      name: `${NAME}:watch`,
      apply: "serve",
      async configureServer(server) {
        const { logger, root } = server.config;
        const config = configPath(root);

        // The watch polls when Vite's watcher was told to: by CHOKIDAR_USEPOLLING when it is set (chokidar's parse of
        // it is in the watcher's options), else by `server.watch.usePolling`. Not by the watcher's own choice alone:
        // chokidar also polls where fsevents is missing or past 128 watchers, which the watch's `fs.watch` needs
        // neither of. It polls at the watcher's interval, CHOKIDAR_INTERVAL's over `server.watch.interval`. The
        // watcher of `server.watch: null` carries no `usePolling`.
        const { watch: serverWatch } = server.config.server;
        const { options: watcher } = server.watcher;
        const polls =
          process.env.CHOKIDAR_USEPOLLING === undefined
            ? serverWatch?.usePolling === true
            : watcher.usePolling === true;
        const polled = polls ? pollEvery(watcher.interval ?? DEFAULT_POLL_MS) : undefined;

        if (polled?._tag === "PollIntervalOutOfRange") {
          // chokidar applies CHOKIDAR_INTERVAL when it is nonempty, over `server.watch.interval`.
          const envInterval = process.env.CHOKIDAR_INTERVAL;
          const source =
            envInterval !== undefined && envInterval !== "" ? "CHOKIDAR_INTERVAL" : "server.watch.interval";
          logger.error(
            `${NAME}: ${source} ${polled.intervalMs} is outside ${MIN_POLL_MS} to ${MAX_POLL_MS} ms; polling every ${DEFAULT_POLL_MS} ms`
          );
        }

        const mode: WatchMode =
          polled === undefined
            ? { _tag: "native" }
            : polled._tag === "PollIntervalOutOfRange"
              ? { _tag: "poll", intervalMs: DEFAULT_POLL_MS }
              : polled;
        // Every compiled catalog compiles again (its compile reads the config), and open tabs are told: at a change of
        // the config, once the restarted watch has a first sync's result (`Restarted`), and once per `Written` result
        // (every sync of the watch that reports what it wrote), besides what Vite's watcher sends for the files it
        // watches. So a new locale's PO that a superseded first sync's retry writes is announced where Vite's watcher
        // does not cover it (outside the root, ignored). A sync that writes some POs and then fails reports `Failed`:
        // no `Written` notice, only `Restarted`'s own when it was a restart's first sync. A notice too many costs a tab a refetch; one too few leaves it stale.
        const reload = () => {
          invalidateCatalogs(server);
          server.environments.client.hot.send({
            type: "custom",
            event: CATALOG_UPDATE_EVENT,
            data: { file: config },
          });
        };
        const report = (result: SyncResult) => {
          if (result._tag === "ConfigChanged") {
            // The reload whatever the log line does: after an edit to an invalid config, no `Restarted` follows.
            try {
              logger.info(`${NAME}: ${relative(root, config)} changed, restarting the catalog watch`, {
                timestamp: true,
              });
            } finally {
              reload();
            }
          } else if (result._tag === "Restarted") {
            reload();
          } else if (result._tag === "Written") {
            // The reload whatever the log line does, as above.
            try {
              logger.info(`${NAME}: wrote ${result.files.map((file) => relative(root, file)).join(", ")}`);
            } finally {
              reload();
            }
          } else if (result._tag === "Failed") {
            result.problems.forEach((problem) => {
              logger.error(describeProblem(problem));
            });
          }
        };
        // A failure that ends the watch once it has started. While the server closes, its logger reports it. Otherwise
        // nothing is left to: it ends the host, as a report that threw always did, from the event loop (`watchProject`
        // ignores what `onEnd` throws).
        const onEnd = ({ cause, closing }: ProjectWatchEnd) => {
          if (closing) {
            logger.error(
              `${NAME}: the catalog watch ended: ${cause instanceof Error ? cause.message : String(cause)}`
            );
          } else {
            queueMicrotask(() => {
              throw new Error(`${NAME}: the catalog watch ended`, { cause });
            });
          }
        };
        const watch = watchProject(services, config, report, onEnd, mode);
        // Stored before anything can fail: a server that closes while it is still starting stops the start there.
        servers.set(server.config, watch);
        // A failed start fails createServer; the watch has released its services and closed its watchers by then.
        await watch.started;
      },
      // Once per environment as the dev server closes, in parallel: every call waits for the watch's one close, which
      // stops it, a start still pending included, and releases its services.
      async closeBundle() {
        await servers.get(this.environment.getTopLevelConfig())?.close();
      },
    },
    {
      name: `${NAME}:check`,
      apply: "build",
      // An input's ancestor watch can cover the output directories, and a rebuild on any environment's output loops
      // (its own, or another's in ping-pong). Set here: the watcher reads its options before any build hook runs.
      // Rolldown matches every watched file against them, a source the check read included (a bundle the config's
      // `include` matches).
      configResolved(config) {
        const outputs = outputDirectories(config).map(
          (output) => new RegExp(`^${RegExp.escape(output)}(?:${RegExp.escape(sep)}|$)`, "u")
        );
        Object.values(config.environments).forEach(({ build }) => {
          if (build.watch) {
            build.watch.exclude = [build.watch.exclude ?? [], outputs].flat();
          }
        });
      },
      // Every build start checks: each environment, each build of a reused config, each watch rebuild. Uncached, so
      // no build can pass on a stale result; the check costs a fraction of the build.
      async buildStart() {
        const config = configPath(this.environment.config.root);
        // `vite build --watch` rebuilds when only the config or catalogs change, so a catalog repair unstalls it. A
        // missing input cannot be watched, so its nearest existing ancestor is (recursively), which sees it created.
        catalogInputs(config).forEach((input) => {
          this.addWatchFile(realpathSync(nearestExisting(input)));
        });
        const result = await check(buildSessions, this.environment, config);
        // And each source the check read, so a repair of one rebuilds: a failed check stops the build before it loads
        // a module, and a source the build never imports is never in its graph. Each file itself, never a directory: a
        // directory watch is recursive, past the extractor's own pruning (`node_modules`, `.git`), and a file-only
        // `build.watch.include` drops it. Never one under an output directory (a bundle the config's `include`
        // matches), which every build rewrites: watched, it rebuilds itself. The outputs are canonical, and so is the
        // second of a source's paths when the first is not. A source created after this check is not watched (#64).
        const outputs = outputDirectories(this.environment.getTopLevelConfig());
        result.sources
          .map((source) => watchedPaths(source))
          .filter((paths) => !paths.some((path) => outputs.some((output) => isWithin(output, path))))
          .flat()
          .forEach((path) => {
            this.addWatchFile(path);
          });

        if (!result.ok) {
          this.error(result.output);
        }
      },
      // Each build's end, per environment: the environment's runtime goes once its running checks have ended. A watch
      // build keeps it for every rebuild, as Rolldown's closeBundle contract asks of watch-mode resources, and its
      // watcher's close releases it.
      async closeBundle() {
        if (!this.meta.watchMode) {
          await buildSessions.release(this.environment);
        }
      },
      async closeWatcher() {
        await buildSessions.release(this.environment);
      },
    },
  ];
}

// Invalidates every compiled catalog in every environment.
function invalidateCatalogs(server: ViteDevServer): void {
  for (const environment of Object.values(server.environments)) {
    for (const [file, modules] of environment.moduleGraph.fileToModulesMap) {
      if (isCatalog(file)) {
        modules.forEach((module) => {
          environment.moduleGraph.invalidateModule(module);
        });
      }
    }
  }
}

// The CLI's own check, so the build fails with exactly what `elmera-intl check` prints, and the source files it read.
// Its output collected per call, so environments checking in parallel each fail with their own.
async function check(
  sessions: HostSessions<Environment, PluginServices>,
  session: Environment,
  config: string
): Promise<
  { readonly sources: ReadonlyArray<string> } & (
    | { readonly ok: true }
    | { readonly ok: false; readonly output: string }
  )
> {
  let output = "";
  const collect = (text: string) => {
    output += text;
  };
  const { outcome, sources } = await sessions.run(
    session,
    inProcessRun("check", { configPath: config, crash: "reject" }).pipe(
      Effect.provide(Reporter.layer({ stdout: collect, stderr: collect }))
    )
  );

  return outcome === "ok"
    ? { ok: true, sources }
    : { ok: false, output: `${NAME} check failed:\n${output}`, sources };
}

// An environment's resolved build options, as far as its output directories go, on every Vite the peer range admits:
// Vite 8 resolves `rolldownOptions` (its `rollupOptions` a deprecated accessor of the same object), Vite 6 and 7 only
// `rollupOptions`. Only Rolldown takes a `cwd`.
type OutputBuild = {
  readonly outDir: string;
  readonly rolldownOptions?: OutputBundler & { readonly cwd?: string | undefined };
  readonly rollupOptions?: OutputBundler;
};
type OutputBundler = { readonly output?: OutputEntry | ReadonlyArray<OutputEntry> | undefined };
type OutputEntry = { readonly dir?: string | undefined };

// Every environment's output directories, canonical, where the bundler writes them: `build.outDir` against the root
// (Vite resolves it, and passes it as the `dir` of an entry without one), and each bundler output entry's own `dir`
// against the bundler's working directory (Rolldown's `cwd`, else the process's), as the bundler resolves it, not the
// root, which Vite's own watch assumes (`getResolvedOutDirs`). Vite refuses `output.file`, so no output is a file.
function outputDirectories({ environments, root }: ResolvedConfig): Array<string> {
  return Object.values(environments).flatMap(({ build }) => {
    const options: OutputBuild = build;
    // `rollupOptions` read only when there is no `rolldownOptions` (Vite 8 deprecates its accessor).
    const { output = [] } = options.rolldownOptions ?? options.rollupOptions ?? {};
    const cwd = options.rolldownOptions?.cwd ?? process.cwd();

    return [
      resolve(root, options.outDir),
      ...[output].flat().flatMap(({ dir }) => (dir === undefined ? [] : [resolve(cwd, dir)])),
    ].map((dir) => canonical(dir));
  });
}

// Whether `path` is `directory` or lies under it.
function isWithin(directory: string, path: string): boolean {
  const below = relative(directory, path);

  return below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below));
}

// The config, each locale's PO and the formats module; just the config when it is missing or invalid, so fixing it
// rebuilds.
function catalogInputs(config: string): Array<string> {
  const loaded = loadConfig(config);

  if (loaded._tag === "ConfigInvalid") {
    return [config];
  }

  const { formats, locales } = loaded.config;

  return [
    config,
    ...locales.map((locale) => catalogPath(loaded.config, locale)),
    ...(formats === undefined ? [] : [formats]),
  ];
}

/**
 * Compile `*.po` imports to their catalogs, alone: what `intl()` adds, for a Vitest config, where neither the dev
 * watcher nor the build check belongs. `import catalog from "./intl/nb.po"` is the `nb` catalog, `"./intl/nb.po?source"`
 * the English one (any locale's PO holds the same msgids). Only the configured locales' catalogs compile, with the
 * config's `formats`; a PO that does not compile fails the import with every problem. In dev, a PO save invalidates
 * its modules in every environment and sends open tabs `CATALOG_UPDATE_EVENT` (see `createCatalogReload` in
 * `@elmeragroup/intl/start`). Under Vitest, catalogs stay out of its file-system module cache.
 *
 * @param options - Where the project config lives.
 * @returns The plugin.
 */
export function intlCatalogs(options: IntlPluginOptions = {}): Plugin {
  // A PO save's notice to open tabs is never held, whatever the dev watch is doing.
  return {
    name: `${NAME}:catalogs`,
    enforce: "pre",
    load(id) {
      const [file = "", query = ""] = id.split("?", 2);

      if (!isCatalog(file)) {
        return null;
      }

      // A Promise for each catalog (every other id stays a synchronous null); the compile (catalog-import.ts) is
      // synchronous, as the loader's: `intlCatalogs` also runs alone (a Vitest config), with no session runtime, so it
      // reads the config and the formats module with Node's sync fs and the process's formats memo. Promise.try turns
      // this.error's throw, and an unreadable PO's, into the hook's rejection.
      return Promise.try(() => {
        const { dependencies, outcome } = compileCatalogImport({
          config: resolve(this.environment.config.root, options.config ?? CONFIG_FILE),
          file,
          readPo: () => readFileSync(file, "utf8"),
          source: new URLSearchParams(query).has("source"),
        });

        // Failed or not. Vite matches the paths of changed files against a module's recorded dependencies, and records
        // a load's dependencies when the load succeeds.
        for (const dependency of dependencies) {
          for (const path of watchedPaths(dependency)) {
            this.addWatchFile(path);
          }
        }

        if (outcome._tag === "Failed") {
          this.error(outcome.error.message);
        }

        return { code: outcome.code, map: null };
      });
    },
    hotUpdate({ file, server }) {
      // Once per save: hotUpdate runs per environment, and the client one exists in every dev server.
      if (!isCatalog(file) || this.environment.name !== "client") {
        return;
      }

      for (const environment of Object.values(server.environments)) {
        environment.moduleGraph.getModulesByFile(file)?.forEach((module) => {
          environment.moduleGraph.invalidateModule(module);
        });
      }
      this.environment.hot.send({ type: "custom", event: CATALOG_UPDATE_EVENT, data: { file } });

      // No client module imports a PO (the server loads the catalog), so nothing to hot-swap in the browser.
      return [];
    },
    // Vitest's file-system module cache keys a transform by the module's own bytes, and a compiled catalog also depends
    // on the config and the formats module, so a run after an edit of either would reuse the old catalog. Generators
    // cannot key on them either: a session keeps the first key it computed for a module until that module's own file
    // changes. So each catalog opts out (`false`), and compiles again whenever Vite's transform misses, as without a
    // cache; every other module keeps the cache (`undefined`). Typed here, so the declarations need no vitest.
    configureVitest(context: VitestCacheKeys) {
      if (context.defineCacheKeyGenerator === undefined) {
        context.experimental_defineCacheKeyGenerator?.(catalogCacheKey);
      } else {
        context.defineCacheKeyGenerator(catalogCacheKey);
      }
    },
  } satisfies Plugin & { readonly configureVitest: (context: VitestCacheKeys) => void };
}

// Every catalog, `?source` included, kept out of Vitest's cache; every other module left as Vitest keys it.
const catalogCacheKey: CacheKeyGenerator = ({ id }) =>
  isCatalog(id.split("?", 1)[0] ?? "") ? false : undefined;

// What Vitest's cache asks a generator of a module: a string mixed into its key, `false` to cache it not at all, or
// `undefined` to leave the key as it is (Vitest's `CacheKeyIdGenerator`, narrowed to what this plugin returns).
type CacheKeyGenerator = (context: { readonly id: string }) => false | undefined;

// The part of Vitest's `configureVitest` context that registers one (`VitestPluginContext`). Vitest 5 names it
// `defineCacheKeyGenerator` and keeps Vitest 4's `experimental_defineCacheKeyGenerator` as a deprecated alias of it;
// Vitest 3 has neither, and no such cache.
type VitestCacheKeys = {
  readonly defineCacheKeyGenerator?: (generator: CacheKeyGenerator) => void;
  readonly experimental_defineCacheKeyGenerator?: (generator: CacheKeyGenerator) => void;
};

function isCatalog(file: string): boolean {
  return file.endsWith(".po");
}

// A catalog import's dependency as the watcher may report its change: the configured path (a change to a symlink itself,
// such as a repointed link, or any change under `resolve.preserveSymlinks`), and its realpath when that differs (a
// change to the file a symlink points at). The configured path alone when the realpath cannot be resolved (a drive
// that is not there), so the import still fails with its own diagnostic.
function watchedPaths(path: string): ReadonlyArray<string> {
  let real: string;
  try {
    real = canonical(path);
  } catch {
    return [path];
  }

  return real === path ? [path] : [path, real];
}

// The real path of `path` through its nearest existing ancestor, with the part that does not exist yet kept as written.
function canonical(path: string): string {
  const existing = nearestExisting(path);

  return join(realpathSync(existing), relative(existing, path));
}
