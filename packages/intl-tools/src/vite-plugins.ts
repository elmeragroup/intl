// The Vite plugins' assembly, over the services their sessions' runtimes provide: `intl()` (vite.ts) supplies the
// real ones.
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Environment, Plugin, ResolvedConfig } from "vite";

import { CATALOG_UPDATE_EVENT } from "@elmeragroup/intl/internal/catalog";

import { compileCatalogImport } from "./catalog-import";
import { oneShot } from "./command-run";
import type { HostSessions } from "./host-sessions";
import { hostSessions } from "./host-sessions";
import { describeProblem } from "./problem";
import { catalogPath } from "./project-catalogs";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { ProjectServices } from "./project-services";
import { Reporter } from "./reporter";
import type { WatchMode, WatchServices } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, pollEvery, watchProject } from "./watch";
import { nearestExisting } from "./watch-trees";

// chokidar's default interval, which Vite's `server.watch` passes on when polling sets none.
const DEFAULT_POLL_MS = 100;

/** Options for `intl()`. */
export type IntlPluginOptions = {
  /** Path of `elmera-intl.json`, relative to the Vite root; defaults to the root's. */
  readonly config?: string;
};

const NAME = "elmera-intl";

// What each session's runtime provides: the watch's services, and the project's services the build's check runs on.
type PluginServices = WatchServices | ProjectServices;

/**
 * The `intl()` plugins, each session's runtime built from `services`: the catalog plugin, the dev server's watch and
 * the build's check.
 *
 * @param options - Where the project config lives.
 * @param services - The services each session's runtime provides.
 * @returns The catalog, dev and build plugins.
 */
export function intlPlugins(
  options: IntlPluginOptions,
  services: Layer.Layer<PluginServices>
): Array<Plugin> {
  const configPath = (root: string) => resolve(root, options.config ?? CONFIG_FILE);
  // Each session runs on its own runtime, so one session's end or failure never touches another's. Each dev server's
  // close (its watch, then its runtime), keyed by its resolved config (a restart's replacement has its own) and stored
  // as soon as its start begins, so a server that closes while it is still starting stops it there.
  const servers = new WeakMap<ResolvedConfig, () => Promise<void>>();
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
        const loaded = loadConfig(configPath(root));

        if (loaded._tag === "ConfigInvalid") {
          logger.error(describeProblem(loaded.problem));

          return;
        }

        // The dev server's own watch setting: an app that polls (`server.watch.usePolling`) polls here too.
        const { watch: serverWatch } = server.config.server;
        const polled =
          serverWatch?.usePolling === true ? pollEvery(serverWatch.interval ?? DEFAULT_POLL_MS) : undefined;

        if (polled?._tag === "PollIntervalOutOfRange") {
          logger.error(
            `${NAME}: server.watch.interval ${polled.intervalMs} is outside ${MIN_POLL_MS} to ${MAX_POLL_MS} ms; polling every ${DEFAULT_POLL_MS} ms`
          );
        }

        const mode: WatchMode =
          polled === undefined
            ? { _tag: "native" }
            : polled._tag === "PollIntervalOutOfRange"
              ? { _tag: "poll", intervalMs: DEFAULT_POLL_MS }
              : polled;
        const runtime = ManagedRuntime.make(services);
        const watcher = watchProject(
          runtime,
          loaded.config,
          (result) => {
            if (result._tag === "Written") {
              logger.info(`${NAME}: wrote ${result.files.map((file) => relative(root, file)).join(", ")}`);
            } else if (result._tag === "Failed") {
              result.problems.forEach((problem) => {
                logger.error(describeProblem(problem));
              });
            }
          },
          mode
        );
        servers.set(server.config, async () => {
          try {
            await watcher.close();
          } finally {
            await runtime.dispose();
          }
        });

        try {
          await watcher.started;
        } catch (error) {
          // The failed start fails createServer, and Vite closes no plugin of a server it never made: this server's
          // runtime goes here, its watchers already closed by the start.
          await runtime.dispose();
          throw error;
        }
      },
      // Once per environment as the dev server closes, in parallel: each asks the watch to stop at once, a start still
      // pending included, and waits for its one ordered shutdown (the first close reports how it ended); then the
      // runtime goes (disposing it again waits for the first disposal), with anything a stop did not reach.
      async closeBundle() {
        await servers.get(this.environment.getTopLevelConfig())?.();
      },
    },
    {
      name: `${NAME}:check`,
      apply: "build",
      // An input's ancestor watch can cover the output directories, and a rebuild on any environment's output loops
      // (its own, or another's in ping-pong). Set here: the watcher reads its options before any build hook runs.
      configResolved({ environments, root }) {
        const builds = Object.values(environments).map(({ build }) => build);
        const outputs = builds.map(({ outDir }) => {
          const output = canonical(resolve(root, outDir));

          return new RegExp(`^${RegExp.escape(output)}(?:${RegExp.escape(sep)}|$)`, "u");
        });
        builds.forEach((build) => {
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

// The CLI's own check, so the build fails with exactly what `elmera-intl check` prints.
// Its output collected per call, so environments checking in parallel each fail with their own.
async function check(
  sessions: HostSessions<Environment, PluginServices>,
  session: Environment,
  config: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly output: string }> {
  let output = "";
  const collect = (text: string) => {
    output += text;
  };
  const outcome = await sessions.run(
    session,
    oneShot("check", { configPath: config, crash: "reject" }).pipe(
      Effect.provide(Reporter.layer({ stdout: collect, stderr: collect }))
    )
  );

  return outcome === "ok" ? { ok: true } : { ok: false, output: `${NAME} check failed:\n${output}` };
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
 * `@elmeragroup/intl/start`).
 *
 * @param options - Where the project config lives.
 * @returns The plugin.
 */
export function intlCatalogs(options: IntlPluginOptions = {}): Plugin {
  return {
    name: `${NAME}:catalogs`,
    enforce: "pre",
    load(id) {
      const [file = "", query = ""] = id.split("?", 2);

      if (!file.endsWith(".po")) {
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

        // Failed or not, each by the realpath the watcher reports (a config or formats module may be a symlink). Vite
        // watches a path as soon as it is added, but ties a load's dependencies to its module only when the hook
        // returns: an edit reloads a compiled import, while a failed one is simply loaded again on the next request (a
        // module that imported it keeps its own cached error until it is itself reloaded).
        for (const dependency of dependencies) {
          this.addWatchFile(canonical(dependency));
        }

        if (outcome._tag === "Failed") {
          this.error(outcome.error.message);
        }

        return { code: outcome.code, map: null };
      });
    },
    hotUpdate({ file, server }) {
      // Once per save: hotUpdate runs per environment, and the client one exists in every dev server.
      if (!file.endsWith(".po") || this.environment.name !== "client") {
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
  };
}

// The watcher reports realpaths, and matches a watched path or exclude only by its realpath. The path may not exist
// yet, so the realpath of its nearest existing ancestor, with the rest re-joined.
function canonical(path: string): string {
  const existing = nearestExisting(path);

  return join(realpathSync(existing), relative(existing, path));
}
