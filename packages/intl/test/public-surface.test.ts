import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import PUBLIC_SURFACE from "./public-surface.json" with { type: "json" };

// Unit under test: the built package, reached as a consumer reaches it: its specifier, resolved by Node through the
// export map under the consumer's conditions. Oracle: public-surface.json, the committed surface: each public subpath
// and the runtime names it exports (types ride along with their subpath). Lint holds src to the same file
// (elmera-workspace/public-surface). Nothing is published yet, so every export added, renamed or dropped there is a
// semver decision to make on purpose.
const REACT = PUBLIC_SURFACE["./react"];

// Node's own resolver (the package resolving itself by name), so export conditions apply as they do for an app;
// Vitest's resolver applies its own. Resolution only: the module loads in Vitest, which can load next's extensionless
// subpaths.
function resolveExport(subpath: string, conditions: ReadonlyArray<string> = []): string {
  const specifier = `${manifest.name}${subpath.slice(1)}`;

  return execFileSync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
      "--input-type=module",
      "--eval",
      `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }
  ).trim();
}

// A module namespace's own string keys are exactly its export names.
async function exportNames(url: string): Promise<ReadonlyArray<string>> {
  return Object.getOwnPropertyNames(await import(url)).toSorted();
}

// Every subpath outside the public surface sits under ./internal/ (nested paths included), which carries no semver
// promise.
it("exports the public subpaths and internal ones only", () => {
  const keys = Object.keys(manifest.exports);

  expect(keys.filter((key) => !key.startsWith("./internal/")).toSorted()).toEqual(
    Object.keys(PUBLIC_SURFACE).toSorted()
  );
});

it.each(Object.entries(PUBLIC_SURFACE))("%s exports its public runtime names", async (subpath, names) => {
  expect(await exportNames(resolveExport(subpath))).toEqual([...names].toSorted());
});

it("/react exports the same names under the react-server condition", async () => {
  const serverReact = resolveExport("./react", ["react-server"]);

  // The condition took effect, so the names below are the server build's.
  expect(serverReact).not.toBe(resolveExport("./react"));
  expect(await exportNames(serverReact)).toEqual([...REACT].toSorted());
});
