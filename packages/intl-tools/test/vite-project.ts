import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { BuildEnvironmentOptions, InlineConfig, Rolldown, ViteDevServer } from "vite";
import { createBuilder, createServer } from "vite";
import { expect, test } from "vitest";

import type { OneShotOutcome } from "../src/command-run";
import { runOnceInProcess } from "../src/command-run";
import { intl } from "../src/vite";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

// The Vite plugin tests' shared project and helpers: the plugins' builds, dev servers and Vitest runs
// (`vite-plugin.test.ts`) and the build watch (`vite-build-watch.test.ts`).

/** The project's config: every source under `src`, one Norwegian catalog. */
export const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
// Every watcher here polls (Rolldown's build watcher and the dev server's, which the plugin's extract watch follows),
// so a wait ends on the edit, not on the host's file-event daemon (fseventsd on macOS delays or drops events under
// load). Polling is the same setting an app on such a host uses; the default native events run in the e2e dev loop.
const POLL_MS = 50;
/**
 * The build watch's polling. Vite 8.3 builds Rolldown's watcher from `build.watch.chokidar`, which its types no longer
 * declare, and replaces the typed `build.watch.watcher` with it; both are set so the build polls whichever Vite reads.
 */
export const BUILD_WATCH = {
  watcher: { usePolling: true, pollInterval: POLL_MS },
  chokidar: { usePolling: true, interval: POLL_MS },
};
/** The dev server's polling. */
export const SERVER_WATCH = { watch: { usePolling: true, interval: POLL_MS } };
/** Probe writes spaced past the watch's 100 ms debounce, so a rewrite does not postpone the sync it waits for. */
export const PROBE_INTERVAL_MS = 500;

/**
 * The Vite tests' `it`: each test owns its project (see `Project`), synced and translated: `<T>Hello</T>` -> "Hei";
 * the entry has no messages, the extractor scans the rest. Every helper takes the project, so a test that overruns
 * cannot touch the next test's files, and every wait ends by the project's deadline. What a test starts (a dev server,
 * a watch build) it closes through `project.defer`, before the root is removed.
 */
export const it = test.extend("project", async ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-vite-", task.timeout);
  onCleanup(close);
  project.write("elmera-intl.json", JSON.stringify(CONFIG));
  project.write("src/main.ts", "export const answer = 42;\n");
  project.write("src/page.tsx", component("Hello"));
  await extractAndTranslate(project);

  return project;
});

/**
 * A source file with one message.
 *
 * @param text - The message.
 * @returns The file's text.
 */
export function component(text: string): string {
  return `import { T } from "@elmeragroup/intl/react";\nexport const C = () => <T>${text}</T>;\n`;
}

/**
 * The project's library build, writing nothing unless `overrides` say so.
 *
 * @param project - The project.
 * @param options - `intl()`'s options.
 * @param overrides - The build options that replace the defaults.
 * @returns The inline config.
 */
export function viteConfig(
  project: Project,
  options: Parameters<typeof intl>[0] = {},
  overrides: BuildEnvironmentOptions = {}
): InlineConfig {
  return {
    root: project.root,
    configFile: false,
    logLevel: "silent",
    plugins: [intl(options)],
    build: {
      write: false,
      lib: { entry: "src/main.ts", formats: ["es"] },
      // The temp project has no node_modules to resolve the runtime from.
      rolldownOptions: { external: [/^@elmeragroup\/intl/u, /^react/u] },
      ...overrides,
    },
  };
}

/** One run of a watch build, from its START. */
export type WatchRun = {
  /** How many changes the watcher had reported when the run started: the changes before that index came first. */
  readonly after: number;
  /** Each of its builds' BUNDLE_END or error message, in order. */
  readonly outcomes: Array<string>;
};

/** One environment's watch build, as its watcher reports it. */
export type WatchLog = {
  /** The environment's name. */
  readonly name: string;
  /** Each build's BUNDLE_START, BUNDLE_END or error message, in order. */
  readonly outcomes: Array<string>;
  /** Each change the watcher reported, as its path under the root, in order. */
  readonly changes: Array<string>;
  /** Each run, in order. */
  readonly runs: Array<WatchRun>;
  /** Whether the watcher's last event is END: its run, every bundle of it, has finished. */
  readonly settled: () => boolean;
};

/**
 * A watch build of `viteConfig` and `extra`, its output under root, each environment on its own watcher, closed when
 * the test ends.
 *
 * @param project - The project.
 * @param extra - The inline config laid over the project's.
 * @param watch - The build's watch options.
 * @param build - More build options, laid over the project's.
 * @returns Each environment's log.
 */
export async function watchBuild(
  project: Project,
  extra: InlineConfig = {},
  watch: BuildEnvironmentOptions["watch"] = BUILD_WATCH,
  build: BuildEnvironmentOptions = {}
): Promise<Array<WatchLog>> {
  project.write("src/main.ts", `export { C } from "./page";\n`);
  const builder = await createBuilder({
    ...viteConfig(project, {}, { watch, write: true, ...build }),
    ...extra,
  });

  return Promise.all(
    Object.values(builder.environments).map(async (environment) => {
      // SAFETY: with build.watch set, an environment's build returns its watcher (the type is the union of every mode).
      const watcher = (await builder.build(environment)) as Rolldown.RolldownWatcher;
      project.defer(() => watcher.close());
      const outcomes: Array<string> = [];
      const changes: Array<string> = [];
      const runs: Array<WatchRun> = [];
      let last = "";
      // The watcher reports realpaths.
      const root = realpathSync(project.root);
      watcher.on("change", (id) => {
        changes.push(relative(root, id));
      });
      watcher.on("event", (event) => {
        last = event.code;

        if (event.code === "START") {
          runs.push({ after: changes.length, outcomes: [] });
        }

        if (event.code === "BUNDLE_START" || event.code === "BUNDLE_END" || event.code === "ERROR") {
          outcomes.push(event.code === "ERROR" ? event.error.message : event.code);
        }

        if (event.code === "BUNDLE_END" || event.code === "ERROR") {
          runs.at(-1)?.outcomes.push(event.code === "ERROR" ? event.error.message : event.code);
        }

        if ("result" in event) {
          void event.result.close();
        }
      });

      return { name: environment.name, outcomes, changes, runs, settled: () => last === "END" };
    })
  );
}

/**
 * `elmera-intl extract` or `check` on the project, silent.
 *
 * @param project - The project.
 * @param command - The command.
 * @returns How it ended.
 */
export async function run(project: Project, command: "extract" | "check"): Promise<OneShotOutcome> {
  return runOnceInProcess(
    command,
    { configPath: project.path("elmera-intl.json"), crash: "reject" },
    { stdout: () => undefined, stderr: () => undefined }
  );
}

/**
 * `elmera-intl extract` on the project, which must end clean.
 *
 * @param project - The project.
 */
export async function extract(project: Project): Promise<void> {
  expect(await run(project, "extract")).toBe("ok");
}

/**
 * Syncs the catalogs and translates them: "Hello" is "Hei", and any other message gets `msgstr`.
 *
 * @param project - The project.
 * @param more - More messages and their translations.
 */
export async function extractAndTranslate(
  project: Project,
  more: ReadonlyArray<readonly [string, string]> = []
): Promise<void> {
  await extract(project);
  let po = project.read("messages/nb.po");
  for (const [source, translation] of [["Hello", "Hei"], ...more]) {
    po = po.replace(
      `msgid ${JSON.stringify(source)}\nmsgstr ""`,
      `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
    );
  }
  project.write("messages/nb.po", po);
}

/**
 * A formats module whose `money` style is the currency `currency`.
 *
 * @param currency - The currency code.
 * @returns The module's text.
 */
export function moneyFormats(currency: string): string {
  return `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`;
}

/**
 * A translated message in the `money` style, which the config's formats module defines with `currency`.
 *
 * @param project - The project.
 * @param currency - The currency code.
 */
export async function useMoneyFormats(project: Project, currency: string): Promise<void> {
  project.write(
    "src/price.tsx",
    `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
  );
  project.write("intl-formats.ts", moneyFormats(currency));
  project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
  await extractAndTranslate(project, [["{n, number, money}", "{n, number, money} totalt"]]);
}

/** One edit a dev case makes: a file's text written, or a symlink repointed (atomically, as a deploy swaps it). */
export type DevEdit =
  | { readonly _tag: "Write"; readonly file: string; readonly text: string }
  | { readonly _tag: "Link"; readonly file: string; readonly target: string };

/**
 * Makes the edit; again, each time: a repeated write is one more change the watcher reports, and each rename of a link
 * prompts another scan of its directory.
 *
 * @param edit - The edit.
 */
export function applyEdit(edit: DevEdit): void {
  if (edit._tag === "Write") {
    writeFileSync(edit.file, edit.text);

    return;
  }

  const next = `${edit.file}.next`;
  rmSync(next, { force: true });
  symlinkSync(edit.target, next);
  renameSync(next, edit.file);
}

/**
 * A directory outside the project root, removed when the test ends.
 *
 * @param project - The project whose teardown removes it.
 * @returns The directory.
 */
export function outsideRoot(project: Project): string {
  const outside = mkdtempSync(join(tmpdir(), "elmera-intl-vite-outside-"));
  project.defer(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  return outside;
}

/**
 * Stages another formats module whose `money` currency is "NOKK", and returns the edit of `config` (the file the
 * project's config is, or links to) that switches the project to it.
 *
 * @param project - The project.
 * @param config - The file the edit writes.
 * @returns The edit.
 */
export function switchFormats(project: Project, config: string): DevEdit {
  project.write("intl-formats-next.ts", moneyFormats("NOKK"));

  return {
    _tag: "Write",
    file: config,
    text: JSON.stringify({ ...CONFIG, formats: "intl-formats-next.ts" }),
  };
}

/**
 * A dev server on the project, closed when the test ends.
 *
 * @param project - The project.
 * @param config - The inline config laid over the project's root.
 * @returns The server.
 */
export async function devServer(project: Project, config: InlineConfig): Promise<ViteDevServer> {
  const server = await createServer({ root: project.root, configFile: false, logLevel: "silent", ...config });
  project.defer(() => server.close());

  return server;
}

/**
 * Writes `text` to `file` (relative to the root, under every watcher's watch), again each probe interval, until each
 * watcher reports it. Rolldown registers a run's watch files after the run, with no event for it, and never reports a
 * change made before then: under load, 9 of 20 configs created after a run's END were never reported (the probe in
 * `.ref`), and one created just after another reported change was missed by the rebuild that change started. A
 * rewrite after the registration is reported, whatever the timing.
 *
 * @param project - The project.
 * @param builds - The watchers that must report it.
 * @param file - The file, relative to the root.
 * @param text - Its text.
 */
export async function untilReported(
  project: Project,
  builds: ReadonlyArray<WatchLog>,
  file: string,
  text: string
): Promise<void> {
  await expect
    .poll(
      () => {
        project.write(file, text);

        return builds.map(({ changes }) => changes.includes(file));
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toEqual(builds.map(() => true));
}

/**
 * Writes a component declaring `message` to `file`, again each probe interval, until a sync adds the message to the
 * PO: the save lands on a live watch whatever its timing. fs.watch has no ready signal, and a recursive watch misses an
 * edit made before its stream starts (seen under load).
 *
 * @param project - The project.
 * @param file - The source, relative to the root.
 * @param message - The message it declares.
 */
export async function untilSynced(project: Project, file: string, message: string): Promise<void> {
  await expect
    .poll(
      () => {
        project.write(file, component(message));

        return project.read("messages/nb.po");
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toContain(`msgid ${JSON.stringify(message)}`);
}
