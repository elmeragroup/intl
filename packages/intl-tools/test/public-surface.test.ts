import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import PUBLIC_SURFACE from "./public-surface.json" with { type: "json" };

// Unit under test: the built package, reached as a consumer reaches it: its specifier, resolved by Node through the
// export map. Oracle: public-surface.json, the committed surface: each subpath and the runtime names it exports.
// Lint holds src to the same file (elmera-workspace/public-surface). Nothing is published yet, so every export added,
// renamed or dropped there is a semver decision to make on purpose.
// `./po` ships only declarations (the `*.po` module types), so it has no runtime module to import.
const RUNTIME_SURFACE = Object.entries(PUBLIC_SURFACE).filter(([subpath]) => subpath !== "./po");

// A test that resolves one subpath in a fresh Node and imports the built entry it names: about 0.1 s on an idle
// machine, past Vitest's default 5 s once under extreme load (load average 77). Its spawn is killed before the test's
// timeout, so a hung Node fails the test with its own error.
const RESOLVES = { timeout: 30_000 };
const SPAWN_GUARD = { timeout: 25_000, killSignal: "SIGKILL" } as const;

// Node's own resolver (the package resolving itself by name), so export conditions apply as they do for an app;
// Vitest's resolver applies its own.
function resolveExport(subpath: string): string {
  const specifier = `${manifest.name}${subpath.slice(1)}`;

  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", ...SPAWN_GUARD }
  ).trim();
}

// A module namespace's own string keys are exactly its export names.
async function exportNames(url: string): Promise<ReadonlyArray<string>> {
  return Object.getOwnPropertyNames(await import(url)).toSorted();
}

it("exports the public subpaths only", () => {
  expect(Object.keys(manifest.exports).toSorted()).toEqual(Object.keys(PUBLIC_SURFACE).toSorted());
});

it.each(RUNTIME_SURFACE)("%s exports its public runtime names", RESOLVES, async (subpath, names) => {
  expect(await exportNames(resolveExport(subpath))).toEqual([...names].toSorted());
});

// The plugin name is the rule-id prefix apps write in .oxlintrc.json, a global namespace: `elmera-intl/extractable`.
it("names the oxlint plugin in the elmera- namespace", RESOLVES, async () => {
  const plugin: unknown = await import(resolveExport("./oxlint"));

  expect(plugin).toHaveProperty("default.meta.name", "elmera-intl");
  expect(plugin).toHaveProperty("default.rules.extractable");
});
