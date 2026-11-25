import { describe, expect } from "vitest";
import type { Reporter } from "vitest/node";
import { createVitest } from "vitest/node";

import { intlCatalogs } from "../src/vite";
import type { Project } from "./project-fixture";
import { CONFIG, it, moneyFormats, PROBE_INTERVAL_MS, SERVER_WATCH, useMoneyFormats } from "./vite-project";

// Unit under test: the catalog plugin under Vitest. Oracle: Intl's currency rules, through a real Vitest's runs.
describe("intlCatalogs() under Vitest", { timeout: 15_000 }, () => {
  // Unit under test: `intlCatalogs()` alone, as a Vitest config takes it, across a Vitest watch rerun, or a second
  // Vitest started after the first one closed, with the default file-system module cache (#54). Oracle: Intl rejects the
  // currency "NOKK", which only the edit makes reachable; the same replay with `fsModuleCache: false` fails the run
  // after it with it (the issue's control). Each row's edit leaves the PO's bytes as they were. A watch row's edit is
  // made again each probe interval until Vitest reruns, so an edit made before its watcher attached is not lost.
  it.for([
    {
      run: "a Vitest watch rerun",
      edited: "config, switched to another formats module",
      watch: true,
      edit: (project: Project) => {
        project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats-next.ts" }));
      },
    },
    {
      run: "a Vitest watch rerun",
      edited: "formats module",
      watch: true,
      edit: (project: Project) => {
        project.write("intl-formats.ts", moneyFormats("NOKK"));
      },
    },
    {
      run: "a second Vitest run",
      edited: "config, switched to another formats module",
      watch: false,
      edit: (project: Project) => {
        project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats-next.ts" }));
      },
    },
  ])("fails $run's catalog import after an edit of the $edited", async ({ watch, edit }, { project }) => {
    await useMoneyFormats(project, "NOK");
    project.write("intl-formats-next.ts", moneyFormats("NOKK"));
    // Globals: the project has no node_modules to import vitest from.
    project.write(
      "test/catalog.test.js",
      `import catalog from "../messages/nb.po";\ntest("loads", () => {\n  expect(Object.keys(catalog)).not.toEqual([]);\n});\n`
    );
    // Each run's outcome: the catalog test module's state and errors.
    const runs: Array<string> = [];
    const reporter: Reporter = {
      onTestRunEnd(modules) {
        runs.push(
          modules
            .map((module) => [module.state(), ...module.errors().map((error) => error.message)].join(": "))
            .join("\n")
        );
      },
    };
    const start = async () => {
      const vitest = await createVitest(
        {
          root: project.root,
          config: false,
          watch,
          globals: true,
          include: ["test/**/*.test.js"],
          // The default cache, kept under the project root instead of the workspace's node_modules.
          fsModuleCachePath: project.path(".vitest-cache"),
          reporters: [reporter],
        },
        { plugins: [intlCatalogs()], server: SERVER_WATCH }
      );
      project.defer(() => vitest.close());
      await project.within(vitest.start(), "a run");

      return vitest;
    };
    const first = await start();
    await expect.poll(() => runs, project.guard()).toEqual(["passed"]);

    if (watch) {
      await expect
        .poll(
          () => {
            if (runs.length === 1) {
              edit(project);
            }

            return runs.length > 1;
          },
          { ...project.guard(), interval: PROBE_INTERVAL_MS }
        )
        .toBe(true);
    } else {
      // The first Vitest closes, as a CLI run ends, before the edit and the second run; only the cache on disk is shared.
      await project.within(first.close(), "the first run's close");
      edit(project);
      await start();
    }

    expect(runs.at(-1)).toMatch(/Invalid currency code : NOKK/u);
  });
});
