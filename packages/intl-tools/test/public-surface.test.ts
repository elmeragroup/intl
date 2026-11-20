import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };

// Unit under test: the built package, reached as a consumer reaches it: its specifier, resolved by Node through the
// export map. Oracle: the tools' public surface as ../intl/docs/adr/0002-naming.md lists it; change both together.
// Nothing is published yet, so every export added, renamed or dropped here is a semver decision to make on purpose.
const PUBLIC_SURFACE = {
  "./vite": ["intl", "intlCatalogs"],
  "./next": ["withIntl"],
  "./compile": ["CatalogCompileError", "compileCatalog", "loadCatalog"],
  "./oxlint": ["default"],
  "./vitest": ["default"],
};
// Subpaths with declarations only (the `*.po` module types), which have no runtime names.
const TYPES_ONLY = ["./po"];

// Node's own resolver (the package resolving itself by name), so export conditions apply as they do for an app;
// Vitest's resolver applies its own.
function resolveExport(subpath: string): string {
  const specifier = `${manifest.name}${subpath.slice(1)}`;

  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }
  ).trim();
}

// A module namespace's own string keys are exactly its export names.
async function exportNames(url: string): Promise<ReadonlyArray<string>> {
  return Object.getOwnPropertyNames(await import(url)).sort();
}

it("exports the public subpaths only", () => {
  expect(Object.keys(manifest.exports).sort()).toEqual(
    [...Object.keys(PUBLIC_SURFACE), ...TYPES_ONLY].sort()
  );
});

it.each(Object.entries(PUBLIC_SURFACE))("%s exports its public runtime names", async (subpath, names) => {
  expect(await exportNames(resolveExport(subpath))).toEqual([...names].sort());
});

// The plugin name is the rule-id prefix apps write in .oxlintrc.json, a global namespace: `elmera-intl/extractable`.
it("names the oxlint plugin in the elmera- namespace", async () => {
  const plugin: unknown = await import(resolveExport("./oxlint"));

  expect(plugin).toHaveProperty("default.meta.name", "elmera-intl");
  expect(plugin).toHaveProperty("default.rules.extractable");
});
