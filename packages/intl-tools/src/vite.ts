// Vite hosting: `import catalog from "./intl/nb.po"` compiles the catalog (`?source` for `en`), `vite dev` runs
// `extract --watch` in-process and reloads open tabs on a PO save, `vite build` runs `check` first.
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

import { CATALOG_UPDATE_EVENT, SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { catalogModule } from "./catalog-module";
import { describeProblem, runCli } from "./cli-run";
import { compileCatalog } from "./compile";
import { catalogLocale, catalogPath, CONFIG_FILE, loadConfig, loadFormats } from "./project";
import type { ProjectWatcher } from "./watch";
import type { WatchMode } from "./watch";
import { MAX_POLL_MS, MIN_POLL_MS, nearestExisting, pollEvery, watchProject } from "./watch";

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
  let watcher: ProjectWatcher | undefined;

  return [
    intlCatalogs(options),
    {
      name: `${NAME}:watch`,
      apply: "serve",
      configureServer(server) {
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
          undefined,
          mode
        );
      },
      async closeBundle() {
        await watcher?.close();
        watcher = undefined;
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
      buildStart() {
        const config = configPath(this.environment.config.root);
        // `vite build --watch` rebuilds when only the config or catalogs change, so a catalog repair unstalls it. A
        // missing input cannot be watched, so its nearest existing ancestor is (recursively), which sees it created.
        catalogInputs(config).forEach((input) => {
          this.addWatchFile(realpathSync(nearestExisting(input)));
        });
        const result = check(config);

        if (!result.ok) {
          this.error(result.output);
        }
      },
    },
  ];
}

// The CLI itself, so the build fails with exactly what `elmera-intl check` prints.
function check(config: string): { readonly ok: true } | { readonly ok: false; readonly output: string } {
  let output = "";
  const collect = (text: string) => {
    output += text;
  };
  const code = runCli(["check", "--config", config], {
    cwd: resolve(config, ".."),
    stdout: collect,
    stderr: collect,
  });

  return code === 0 ? { ok: true } : { ok: false, output: `${NAME} check failed:\n${output}` };
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
