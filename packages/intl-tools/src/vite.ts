// Vite hosting: `import catalog from "./intl/nb.po"` compiles the catalog (`?source` for `en`), `vite dev` runs
// `extract --watch` in-process and reloads open tabs on a PO save, `vite build` runs `check` first.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

import { CATALOG_UPDATE_EVENT, SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { catalogModule } from "./catalog-module";
import type { OneShotOutcome } from "./command-run";
import { oneShot } from "./command-run";
import { compileCatalog } from "./compile";
import { describeProblem } from "./problem";
import { catalogLocale, catalogPath } from "./project-catalogs";
import { CONFIG_FILE, loadConfig } from "./project-config";
import { loadFormats } from "./project-formats";
import { Reporter } from "./reporter";
import type { ProjectWatcher, WatchMode, WatchServices } from "./watch";
import { CatalogSync, MAX_POLL_MS, MIN_POLL_MS, pollEvery, watchProject } from "./watch";
import { FileEvents, nearestExisting } from "./watch-trees";

// chokidar's default interval, which Vite's `server.watch` passes on when polling sets none.
const DEFAULT_POLL_MS = 100;

/** Options for `intl()`. */
export type IntlPluginOptions = {
  /** Path of `elmera-intl.json`, relative to the Vite root; defaults to the root's. */
  readonly config?: string;
};

const NAME = "elmera-intl";

/**
 * The `@elmeragroup/intl` Vite plugin. A `*.po` import compiles to its catalog (`intlCatalogs`). Dev keeps the
 * catalogs in sync on save (add-only, problems printed to the terminal); build fails before bundling when
 * `elmera-intl check` finds a problem, with the CLI's output.
 *
 * @param options - Where the project config lives.
 * @returns The catalog, dev and build plugins.
 */
export function intl(options: IntlPluginOptions = {}): Array<Plugin> {
  const configPath = (root: string) => resolve(root, options.config ?? CONFIG_FILE);
  // What this instance runs its programs on: the dev server's watch, and each build's check.
  const runtime = pluginRuntime();
  // The watch as soon as its start begins: a dev server that closes while it is still starting closes it too.
  let watcher: Promise<ProjectWatcher> | undefined;
  // Every stop of the watch begun so far, settled: the runtime's disposal waits for them, so it never cuts one short.
  let stopped: Promise<unknown> = Promise.resolve();

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
        watcher = watchProject(
          runtime.current(),
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

        try {
          await watcher;
        } catch (error) {
          // The failed start fails createServer, and Vite closes no plugin of a server it never made: the runtime goes
          // here, its watchers already closed by the start.
          await runtime.dispose();
          throw error;
        }
      },
      // Once per environment as the dev server closes, in parallel: the first stops the watch (once its start has
      // settled), in order, reporting how it ended; each then waits for every stop begun, and the runtime goes, with
      // anything a stop did not reach.
      async closeBundle() {
        const starting = watcher;
        watcher = undefined;
        // A start that failed has stopped already, and failed the dev server's start with its error.
        const stopping = starting?.then(
          (running) => running.close(),
          () => undefined
        );
        stopped = Promise.allSettled([stopped, stopping]);
        try {
          await stopping;
        } finally {
          await stopped;
          await runtime.dispose();
        }
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
        const result = await check(runtime, config);

        if (!result.ok) {
          this.error(result.output);
        }
      },
      // Each build's end, per environment: the next build (a reused config's) starts a fresh runtime. A watch build keeps
      // it for every rebuild, as Rolldown's closeBundle contract asks of watch-mode resources, and its watcher's close
      // disposes it.
      async closeBundle() {
        if (!this.meta.watchMode) {
          await runtime.dispose();
        }
      },
      async closeWatcher() {
        await runtime.dispose();
      },
    },
  ];
}

/** A plugin instance's runtime, one at a time: made on first use, disposed when the host is done with it. */
type PluginRuntime = {
  /** The runtime, made now unless one is live. */
  readonly current: () => ManagedRuntime.ManagedRuntime<WatchServices, never>;
  /**
   * Runs `effect` on the current runtime.
   *
   * @throws What the effect failed or died with.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E, WatchServices>) => Promise<A>;
  /**
   * Retires the current runtime, so the next use makes a new one, and disposes it: any watch still on it is interrupted
   * and closed. Safe to call again, or with no runtime: it then waits for the disposal already under way.
   */
  readonly dispose: () => Promise<void>;
};

// The build reuses one plugin instance for every environment and every build of a reused config: a build after an end
// must find a runtime. The check is synchronous within its fiber, so a disposal cannot cut one short (layer 6, whose
// check is asynchronous, makes the disposal wait for running checks).
function pluginRuntime(): PluginRuntime {
  let runtime: ManagedRuntime.ManagedRuntime<WatchServices, never> | undefined;
  let disposed: Promise<void> = Promise.resolve();
  const current = () =>
    (runtime ??= ManagedRuntime.make(Layer.mergeAll(CatalogSync.layer(), FileEvents.layer())));

  return {
    current,
    run: async (effect) => {
      const exit = await current().runPromiseExit(effect);

      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }

      return exit.value;
    },
    dispose: () => {
      const retired = runtime;
      runtime = undefined;

      if (retired !== undefined) {
        disposed = Promise.all([disposed, retired.dispose()]).then(() => undefined);
      }

      return disposed;
    },
  };
}

// The CLI's own check, so the build fails with exactly what `elmera-intl check` prints.
// Its output collected per call, so environments checking in parallel each fail with their own.
async function check(
  runtime: PluginRuntime,
  config: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly output: string }> {
  let output = "";
  const collect = (text: string) => {
    output += text;
  };
  const outcome: OneShotOutcome = await runtime.run(
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

      // A Promise for each catalog (every other id stays a synchronous null), so a later layer can compile behind an
      // Effect program; the compile itself is still synchronous, and Promise.try turns this.error's throw into the
      // hook's rejection.
      return Promise.try(() => {
        const loaded = loadConfig(resolve(this.environment.config.root, options.config ?? CONFIG_FILE));

        if (loaded._tag === "ConfigInvalid") {
          this.error(describeProblem(loaded.problem));
        }

        const { config } = loaded;
        const locale = catalogLocale(config, file);

        if (locale === undefined) {
          this.error(
            `${relative(config.root, file)} is not a configured catalog (${config.catalogs}, ${config.locales.join(", ")})`
          );
        }

        // Before loading, so saving a repaired formats module reloads an import that failed on it.
        if (config.formats !== undefined) {
          this.addWatchFile(config.formats);
        }

        const formats = loadFormats(config);

        if (formats._tag === "ConfigInvalid") {
          this.error(describeProblem(formats.problem));
        }

        const source = new URLSearchParams(query).has("source");
        const compiled = compileCatalog(readFileSync(file, "utf8"), source ? SOURCE_LOCALE : locale, {
          formats: formats.formats,
        });

        if (compiled._tag === "CatalogCompileError") {
          this.error(compiled.message);
        }

        return { code: catalogModule(compiled.catalog), map: null };
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
