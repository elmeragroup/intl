// Vitest global setup for apps: `globalSetup: ["@elmeragroup/intl-tools/vitest"]` fails the run when the app's catalogs have
// problems. It runs the built CLI in-process in the vitest project root (vitest passes the project to a global
// setup), so `vitest --root apps/x` from anywhere checks that app; turbo builds this package (`^build`) before app
// tests. Unbuilt, vitest stops before any test with "Failed to load url @elmeragroup/intl-tools/vitest": run
// `pnpm --filter @elmeragroup/intl-tools build`.
import process from "node:process";

import { runGuarded } from "./cli-run";

/**
 * Run `elmera-intl check` in the vitest project root; problems go to stderr.
 *
 * @param project - The vitest project (its `TestProject`) whose root holds `elmera-intl.json`.
 * @throws When check finds problems (exit 1) or could not run (exit 2): the test run must stop.
 */
export default function checkIntlCatalogs(project: { readonly config: { readonly root: string } }): void {
  const app = project.config.root;
  const code = runGuarded(["check"], {
    cwd: app,
    stdout: () => undefined,
    stderr: (text) => process.stderr.write(text),
  });

  // Exit 1 covers a stale catalog and an invalid config alike: the problems above name which.
  if (code === 1) {
    throw new Error(
      `elmera-intl check found problems in ${app} (above), each with its fix; a stale catalog needs \`pnpm exec elmera-intl extract\` there and any new msgstr translated`
    );
  }

  if (code !== 0) {
    throw new Error(`elmera-intl check could not run in ${app} (output above)`);
  }
}
