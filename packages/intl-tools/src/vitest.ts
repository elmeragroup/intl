// Vitest global setup for apps: `globalSetup: ["@elmeragroup/intl-tools/vitest"]` fails the run when the app's catalogs have
// problems. It runs the built CLI's check in-process in the vitest project root (vitest passes the project to a global
// setup), so `vitest --root apps/x` from anywhere checks that app; turbo builds this package (`^build`) before app
// tests. Unbuilt, vitest stops before any test with "Failed to load url @elmeragroup/intl-tools/vitest": run
// `pnpm --filter @elmeragroup/intl-tools build`.
import { resolve } from "node:path";
import process from "node:process";

import { runOnceInProcess } from "./command-run";
import { CONFIG_FILE } from "./project-config";

/**
 * Run `elmera-intl check` in the vitest project root; problems go to stderr.
 *
 * @param project - The vitest project (its `TestProject`) whose root holds `elmera-intl.json`.
 * @returns Once check is clean; vitest awaits a global setup.
 * @throws When check finds problems or could not run: the test run must stop (as a rejection).
 */
export default async function checkIntlCatalogs(project: {
  readonly config: { readonly root: string };
}): Promise<void> {
  const app = project.config.root;
  const outcome = await runOnceInProcess(
    "check",
    { configPath: resolve(app, CONFIG_FILE), crash: "report" },
    { stdout: () => undefined, stderr: (text) => process.stderr.write(text) }
  );

  // Problems cover a stale catalog and an invalid config alike: the problems above name which.
  if (outcome === "problems") {
    throw new Error(
      `elmera-intl check found problems in ${app} (above), each with its fix; a stale catalog needs \`pnpm exec elmera-intl extract\` there and any new msgstr translated`
    );
  }

  if (outcome === "crashed") {
    throw new Error(`elmera-intl check could not run in ${app} (output above)`);
  }
}
