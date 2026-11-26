import { realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildEnvironmentOptions, Plugin, Rolldown } from "vite";
import { build as viteBuild } from "vite";
import { describe, expect } from "vitest";

import { intl } from "../src/vite";
import type { Project } from "./project-fixture";
import type { WatchLog } from "./vite-project";
import {
  BUILD_WATCH,
  component,
  CONFIG,
  extract,
  extractAndTranslate,
  it,
  moneyFormats,
  outsideRoot,
  PROBE_INTERVAL_MS,
  untilReported,
  useMoneyFormats,
  viteConfig,
  watchBuild,
} from "./vite-project";

// A source the extractor rejects: a call to `t` with a key it cannot read (ExtractFailed).
const BROKEN = `import { useT } from "@elmeragroup/intl/react";\nexport const C = () => {\n  const t = useT();\n  const key = "Hello";\n  return t(key);\n};\n`;

// Whether the watch build is at rest: its last run has ended, and it started after every change reported, so no change
// waits for a run.
function quiet(log: WatchLog): boolean {
  return log.settled() && log.runs.at(-1)?.after === log.changes.length;
}

// Writes `text` to `file`, again each probe interval, until the watcher reports it after its first `from` changes,
// then waits until the build is at rest.
async function untilRewriteReported(
  project: Project,
  log: WatchLog,
  file: string,
  text: string,
  from: number
): Promise<void> {
  await expect
    .poll(
      () => {
        project.write(file, text);

        return log.changes.slice(from).includes(file);
      },
      { ...project.guard(), interval: PROBE_INTERVAL_MS }
    )
    .toBe(true);
  await expect.poll(() => quiet(log), project.guard()).toBe(true);
}

// `relative` under the project's canonical root: Vite resolves its root through links, so the check's sources are
// joined to it.
function canonicalPath(project: Project, relative: string): string {
  return join(realpathSync(project.root), relative);
}

// intl()'s plugins, with each path its check plugin's buildStart passes to `addWatchFile` recorded as the call goes on
// to the real context.
function recordWatchFiles() {
  const watched = new Set<string>();
  const plugins = intl().map((plugin): Plugin => {
    const { buildStart: hook } = plugin;

    if (plugin.name !== "elmera-intl:check" || hook === undefined) {
      return plugin;
    }
    const buildStart = "handler" in hook ? hook.handler : hook;

    return {
      ...plugin,
      buildStart(options) {
        const forward = this.addWatchFile.bind(this);
        // SAFETY: Object.create types its result `any`. The object inherits every member of the hook's context and
        // overrides only addWatchFile, which records the path and forwards the call.
        const context = Object.create(this, {
          addWatchFile: {
            value: (id: string) => {
              watched.add(id);
              forward(id);
            },
          },
        }) as ThisParameterType<typeof buildStart>;

        return buildStart.call(context, options);
      },
    };
  });

  return { plugins, watched };
}

// An inert entry (no message) and, in each of `dirs`, its bundle as a build writes it, with the config's `include`
// extended to the bundles: what the plugin must watch (the entry), and must not (each bundle, as the root spells it and
// canonical).
function withBundles(project: Project, dirs: ReadonlyArray<string>) {
  const inert = "export const answer = 42;\n";
  project.write("src/inert.ts", inert);
  dirs.forEach((dir) => {
    project.write(`${dir}/main.js`, inert);
  });
  project.write(
    "elmera-intl.json",
    JSON.stringify({ ...CONFIG, include: [...CONFIG.include, ...dirs.map((dir) => `${dir}/**/*.js`)] })
  );

  return {
    watched: [canonicalPath(project, "src/inert.ts")],
    unwatched: dirs.flatMap((dir) => [
      project.path(`${dir}/main.js`),
      canonicalPath(project, `${dir}/main.js`),
    ]),
  };
}

// A library build of the inert entry into `output`'s directories, each bundle `main.js`.
function bundleBuild(
  output: (project: Project) => Rolldown.OutputOptions | Array<Rolldown.OutputOptions>
): (project: Project) => BuildEnvironmentOptions {
  return (project) => ({
    lib: { entry: "src/inert.ts", formats: ["es"], fileName: () => "main.js" },
    // Each output written over the bundle already there, unemptied, so every check reads the bundles the config's
    // `include` names.
    emptyOutDir: false,
    rolldownOptions: { external: [/^@elmeragroup\/intl/u, /^react/u], output: output(project) },
  });
}

// Unit under test: the intl() build plugin in `vite build --watch`. Oracle: the check's problem codes, Intl's currency
// rules and Rolldown's poll watcher, which reports a change only to a file the build watches.
describe("intl() vite build watch", { timeout: 15_000 }, () => {
  it("checks the catalogs again after a watch rebuild, and rebuilds on a catalog-only repair", async ({
    project,
  }) => {
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes, project.guard()).toContain("BUNDLE_END");
    project.write("src/page.tsx", component("Untranslated"));
    await expect.poll(() => outcomes.at(-1), project.guard()).toContain("CatalogOutOfSync");

    // The repair touches only the catalog: extract, then translate.
    await extract(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(`msgid "Untranslated"\nmsgstr ""`, `msgid "Untranslated"\nmsgstr "Uoversatt"`)
    );
    await expect.poll(() => outcomes.at(-1), project.guard()).toBe("BUNDLE_END");
  });

  // Oracle: Intl rejects the currency "NOKK". The edit touches only the formats module.
  it("checks the catalogs with the edited formats module after a watch rebuild", async ({ project }) => {
    await useMoneyFormats(project, "NOK");
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes, project.guard()).toContain("BUNDLE_END");

    project.write("intl-formats.ts", moneyFormats("NOKK"));
    await expect.poll(() => outcomes.at(-1), project.guard()).toMatch(/Invalid currency code : NOKK/u);
  });

  // Unit under test: the build plugin's exclude of every environment's output from its watch. Oracle: Rolldown's poll
  // watcher reports each change it sees, and a change it reports starts a rebuild: a watch that covers an output
  // reports that output's write, and rebuilds on it, in a loop. The watch covers the project root, where every
  // environment writes its output (the config is missing, so its nearest existing ancestor is watched), a custom
  // `build.rolldownOptions.output.dir` included.
  it.for([
    { environments: "one environment", names: ["client"], extra: {}, build: () => ({}) },
    {
      // Its bundle outside `build.outDir`: only the exclusion of every output directory keeps the root's watch off it.
      environments: "one environment into a custom output directory",
      names: ["client"],
      extra: {},
      build: (project: Project): BuildEnvironmentOptions => ({
        rolldownOptions: {
          external: [/^@elmeragroup\/intl/u, /^react/u],
          output: { dir: project.path("out") },
        },
      }),
    },
    {
      environments: "client and SSR",
      names: ["client", "ssr"],
      // Each environment its own watch options (as when set per environment), so neither inherits the other's
      // exclude through a shared object.
      extra: {
        builder: {},
        environments: {
          client: { build: { outDir: "dist/client", watch: BUILD_WATCH } },
          ssr: { build: { outDir: "dist/server", watch: BUILD_WATCH } },
        },
      },
      build: () => ({}),
    },
  ])(
    "rebuilds $environments when a missing config is created, then stays idle",
    async ({ names, extra, build }, { project }) => {
      const config = project.read("elmera-intl.json");
      rmSync(project.path("elmera-intl.json"));
      const builds = await watchBuild(project, extra, BUILD_WATCH, build(project));
      // Every environment builds, each on its own watcher, so every assertion below holds for each of them.
      expect(builds.map(({ name }) => name)).toEqual(names);
      const last = () => builds.map(({ outcomes }) => outcomes.at(-1));
      await expect
        .poll(() => last().map((outcome) => outcome?.includes("elmera-intl.json")), project.guard())
        .toEqual(builds.map(() => true));

      // Created, then rewritten until each watcher reports it: the root's watch (its nearest existing ancestor) is
      // the only one that can see it, so a report means the plugin watched the ancestor.
      await untilReported(project, builds, "elmera-intl.json", config);
      await expect
        .poll(() => builds.map(({ outcomes, settled }) => [outcomes.at(-1), settled()]), project.guard())
        .toEqual(builds.map(() => ["BUNDLE_END", true]));

      // Idle: the repaired build's outputs are written before the entry below is touched, and a poll watcher reports
      // every change it has seen by the time it reports a later one, so once each watcher has reported the touch, any
      // output it reports would be among the changes. Every one is the config or the touch.
      await untilReported(project, builds, "src/main.ts", project.read("src/main.ts"));
      expect(
        builds.map(({ changes }) =>
          changes.filter((change) => !/^(?:elmera-intl\.json|src\/main\.ts)$/u.test(change))
        )
      ).toEqual(builds.map(() => []));
    }
  );

  // Each removal returns a repair that writes only what is missing, so only a watch on it (or an ancestor) rebuilds.
  it.for([
    {
      missing: "the catalog directory",
      remove: (project: Project) => {
        rmSync(project.path("messages"), { recursive: true });

        return () => extractAndTranslate(project);
      },
    },
    {
      // Restored as is (a checkout, say).
      missing: "a locale's PO",
      remove: (project: Project) => {
        const po = project.read("messages/nb.po");
        rmSync(project.path("messages/nb.po"));

        return () => {
          project.write("messages/nb.po", po);

          return Promise.resolve();
        };
      },
    },
  ])("rebuilds when $missing is created", async ({ remove }, { project }) => {
    const repair = remove(project);
    const [{ outcomes } = { outcomes: [] }] = await watchBuild(project);
    await expect.poll(() => outcomes.at(-1), project.guard()).toContain("elmera-intl check failed");

    await repair();
    await expect.poll(() => outcomes.at(-1), project.guard()).toBe("BUNDLE_END");
  });

  // Unit under test: the build plugin's watch of the sources its check read (#39), at its own boundary: what its
  // buildStart passes to `addWatchFile`, recorded as it forwards to the real context. Oracle, by hand: the files each
  // row's project holds. A build whose check fails loads no module and a source the build never imports is in no
  // module graph, so only the plugin's registration can watch them; and a bundle under any output directory, which the
  // config's `include` matches, is never watched (each build rewrites it, so watching it rebuilds forever).
  it.for([
    {
      sources: "a source the build never imports, after a passing build",
      prepare: (project: Project) => {
        project.write("src/other.tsx", "export const other = 1;\n");

        return { watched: [canonicalPath(project, "src/other.tsx")], unwatched: [] };
      },
      build: () => ({}),
      ok: true,
    },
    {
      sources: "a symlinked source and its target, after a failed check",
      prepare: (project: Project) => {
        const target = join(outsideRoot(project), "page.tsx");
        writeFileSync(target, BROKEN);
        rmSync(project.path("src/page.tsx"));
        symlinkSync(target, project.path("src/page.tsx"));

        return { watched: [canonicalPath(project, "src/page.tsx"), realpathSync(target)], unwatched: [] };
      },
      build: () => ({}),
      ok: false,
    },
    {
      sources: "the sources, but no bundle in a custom output directory",
      prepare: (project: Project) => withBundles(project, ["out"]),
      build: bundleBuild((project: Project) => ({ dir: project.path("out") })),
      ok: true,
    },
    {
      sources: "the sources, but no bundle in any of several output directories",
      prepare: (project: Project) => withBundles(project, ["out", "out-cjs"]),
      build: bundleBuild((project: Project) => [
        { dir: project.path("out"), format: "es" },
        { dir: project.path("out-cjs"), format: "cjs" },
      ]),
      ok: true,
    },
    {
      // Rolldown resolves a relative `dir` against the process's working directory, here `build/`, not the Vite root.
      sources: "the sources, but no bundle in an output directory relative to the working directory",
      prepare: (project: Project) => withBundles(project, ["build/out"]),
      build: bundleBuild(() => ({ dir: "out" })),
      cwd: "build",
      ok: true,
    },
    {
      // And against Rolldown's own `cwd`, when one is set.
      sources: "the sources, but no bundle in an output directory relative to Rolldown's cwd",
      prepare: (project: Project) => withBundles(project, ["build/out"]),
      build: (project: Project): BuildEnvironmentOptions => {
        const options = bundleBuild(() => ({ dir: "out" }))(project);

        return { ...options, rolldownOptions: { ...options.rolldownOptions, cwd: project.path("build") } };
      },
      ok: true,
    },
  ])("watches $sources", async ({ prepare, build, ok, ...row }, { project }) => {
    const { watched: expected, unwatched } = prepare(project);
    // Each bundle dated to the epoch, so a build that writes it there moves its modification time.
    unwatched.forEach((path) => {
      utimesSync(path, 0, 0);
    });
    const { plugins, watched } = recordWatchFiles();
    const start = process.cwd();
    let built = false;
    try {
      if ("cwd" in row && row.cwd !== undefined) {
        process.chdir(project.path(row.cwd));
      }
      // Written, so each bundle lands where the bundler resolves its directory.
      built = await viteBuild({
        ...viteConfig(project, {}, { ...build(project), write: true }),
        plugins,
      }).then(
        () => true,
        () => false
      );
    } finally {
      process.chdir(start);
    }

    expect({
      ok: built,
      missing: expected.filter((path) => !watched.has(path)),
      watchedOutputs: unwatched.filter((path) => watched.has(path)),
      // Each bundle is where the row expects it: the build wrote it there (a passing build writes every output).
      rewritten: unwatched.map((path) => statSync(path).mtimeMs > 0),
    }).toEqual({ ok, missing: [], watchedOutputs: [], rewritten: unwatched.map(() => true) });
  });

  // Unit under test: the build plugin's exclusion of every output directory from its watch, on the resolved config as
  // Vite 6 and 7 shape it: `build.rollupOptions`, and no `build.rolldownOptions` (outside the peer range, `^8.2.0`;
  // kept for widening it back, #96). Oracle, by hand: the custom `dir`'s bundle matches an exclusion. The hook is called as Vite calls it, with the resolved
  // config, and a failure is captured so the assertion names it.
  it("excludes a custom output directory from a Vite 6 build's watch", ({ project }) => {
    const hook = intl().find(({ name }) => name === "elmera-intl:check")?.configResolved;
    const configResolved = hook === undefined || !("handler" in hook) ? hook : hook.handler;
    // The watch options the hook extends with its exclusions.
    const watch = { exclude: new Array<RegExp>() };
    const resolved = {
      root: project.root,
      environments: {
        client: { build: { outDir: "dist", watch, rollupOptions: { output: { dir: project.path("out") } } } },
      },
    };
    let outcome = "resolved";
    try {
      // SAFETY: the hook reads no `this`, and of the config only the root and each environment's build `outDir`,
      // `watch` and bundler options, which this has as Vite 6 resolves them; a whole ResolvedConfig is not
      // constructible here.
      void configResolved?.call({} as never, resolved as never);
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }

    const bundle = canonicalPath(project, "out/main.js");
    expect({ outcome, excluded: watch.exclude.some((pattern) => pattern.test(bundle)) }).toEqual({
      outcome: "resolved",
      excluded: true,
    });
  });

  // Unit under test: the same watch, in a real `vite build --watch` with a file-only `build.watch.include` (Rolldown
  // matches every registration against it, so a directory registration would be dropped; the catalog is admitted for
  // the plugin's own inputs). Oracle: Rolldown's poll watcher reports a change only to a file the build watches, and
  // a run it starts checks again; by hand, the repaired source holds a translated message. The registration is
  // asserted first. Then the only file written is the source: its repair, again each probe interval (Rolldown never
  // reports a write made before its poll watcher takes the new watch's baseline), until a run ends with the bundle.
  // Nothing else changes, so that run was started by the source's report.
  it("rebuilds on a source-only repair after a failed check, under a file-only build.watch.include", async ({
    project,
  }) => {
    project.write("src/page.tsx", BROKEN);
    const { plugins, watched } = recordWatchFiles();
    const [log] = await watchBuild(project, { plugins }, { ...BUILD_WATCH, include: [/\.tsx$/u, /\.po$/u] });
    expect(log).toBeDefined();
    if (log === undefined) {
      return;
    }
    await expect.poll(() => quiet(log), project.guard()).toBe(true);
    expect([log.runs.at(-1)?.outcomes.at(-1), watched.has(canonicalPath(project, "src/page.tsx"))]).toEqual([
      expect.stringMatching(/ExtractFailed/u),
      true,
    ]);

    const from = log.changes.length;
    await expect
      .poll(
        () => {
          project.write("src/page.tsx", component("Hello"));

          return quiet(log) && log.runs.at(-1)?.outcomes.at(-1);
        },
        { ...project.guard(), interval: PROBE_INTERVAL_MS }
      )
      .toBe("BUNDLE_END");
    expect(new Set(log.changes.slice(from))).toEqual(new Set(["src/page.tsx"]));
  });

  // Unit under test: the build plugin's exclusion of every output directory from its watch, a custom
  // `build.rolldownOptions.output.dir` included (an object or an array of outputs), in a real `vite build --watch`
  // whose config's `include` matches the bundles. Oracle: Rolldown's poll watcher reports each change to a file the
  // build watches, and each build rewrites its bundles, so a watched bundle is reported. The entry is inert (no
  // message), so every run's check passes and every run writes its bundles. Idle: the entry is written as it is until
  // reported, twice: the second run wrote the bundles after the first report (by when every watch registered at the
  // first run has its baseline) and before the second write, and a poll watcher reports every change it has seen by
  // the time it reports a later one. Every reported change is the entry.
  it.for([
    {
      outputs: "a custom output directory",
      dirs: ["out"],
      build: bundleBuild((project: Project) => ({ dir: project.path("out") })),
    },
    {
      outputs: "an array of outputs",
      dirs: ["out", "out-cjs"],
      build: bundleBuild((project: Project) => [
        { dir: project.path("out"), format: "es" },
        { dir: project.path("out-cjs"), format: "cjs" },
      ]),
    },
  ])("does not rebuild itself on its bundle in $outputs", async ({ dirs, build }, { project }) => {
    withBundles(project, dirs);
    const [log] = await watchBuild(project, {}, BUILD_WATCH, build(project));
    expect(log).toBeDefined();
    if (log === undefined) {
      return;
    }
    await expect.poll(() => quiet(log), project.guard()).toBe(true);
    const inert = project.read("src/inert.ts");
    await untilRewriteReported(project, log, "src/inert.ts", inert, 0);
    await untilRewriteReported(project, log, "src/inert.ts", inert, log.changes.length);

    expect({
      outcomes: log.runs.map((run) => run.outcomes.at(-1)),
      changes: log.changes.filter((change) => change !== "src/inert.ts"),
    }).toEqual({ outcomes: log.runs.map(() => "BUNDLE_END"), changes: [] });
  });
});
