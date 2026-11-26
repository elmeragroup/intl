import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tsrsManifest from "tsrs/package.json" with { type: "json" };
import { expect, it, onTestFinished } from "vitest";

import manifest from "../package.json" with { type: "json" };
import PUBLIC_SURFACE from "./public-surface.json" with { type: "json" };

// Unit under test: the built package, reached as a consumer reaches it: its specifier, resolved by Node through the
// export map under the consumer's conditions. Oracle: public-surface.json, the committed surface: each public subpath
// and the runtime names it exports (types ride along with their subpath). Lint holds src to the same file
// (elmera-workspace/public-surface). Nothing is published yet, so every export added, renamed or dropped there is a
// semver decision to make on purpose.
const REACT = PUBLIC_SURFACE["./react"];

// The installed tsrs CLI: a JavaScript launcher at the path its manifest's `bin` names, resolved from this package's
// own dependency rather than looked up on PATH.
const TSRS = join(
  dirname(createRequire(import.meta.url).resolve("tsrs/package.json")),
  tsrsManifest.bin.tsrs
);

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

// Unit under test: the built `/server` without a host's alias (Next: withIntl), which falls back to the request config
// stub it imports by specifier: directly without conditions (client and SSR code), and through the react-server request
// config and the request module's specifier under `react-server` (server components). Reached as an app's server
// reaches it: a plain Node process resolving the package by name, with no Vitest alias (vitest.config.ts maps the
// specifiers to a test fixture) and only the given conditions. Oracle: the stub's contract: `/server` loads everywhere,
// and its first read rejects with the setup to fix (the request module and withIntl, and the provider's hooks for a
// Client Component).
it.each([
  { condition: "no condition", flags: [] },
  { condition: "react-server", flags: ["--conditions=react-server"] },
])(
  "/server without the host alias under $condition loads, and getIntl() rejects naming intl/request.ts, withIntl and the Client Component remedy",
  ({ flags }) => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        ...flags,
        "--input-type=module",
        "--eval",
        `const { getIntl } = await import(${JSON.stringify(`${manifest.name}/server`)});
       await getIntl().then(() => console.log("resolved"), (error) => console.log(error.message));`,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        // An empty environment: no NODE_OPTIONS (Vitest's, or the source condition the lint script sets) reaches it.
        env: {},
        // A hang guard only: the process exits once the rejection is printed.
        timeout: 30_000,
      }
    );

    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    // The guidance for each cause, not one sentence: the request module and withIntl for server code, the provider's
    // hooks for a Client Component.
    expect(stdout).toMatch(/intl\/request\.ts/u);
    expect(stdout).toMatch(/withIntl/u);
    expect(stdout).toMatch(/Client Component.*useT and useFormat from @elmeragroup\/intl\/react/u);
  }
);

// Unit under test: the built declarations of each host's `useLocaleSwitch`, as a consumer's declaration emit reads them.
// Oracle: TypeScript's declaration emit (tsrs, the workspace's compiler) for a shared UI package that exports a wrapper
// with an inferred return type. The emit fails with TS2883 when that type is reachable only through a private, hashed
// chunk of this package, and otherwise names it through the subpath the checker reaches it by, as the declarations
// built before the switch moved to a shared module did. One file wraps both hosts' hooks, so each line must name its
// own host: a `LocaleSwitch` that both hosts re-export from one place passes a single-host consumer but types the
// second wrapper through the first host's subpath. The check runs only for a consumer of this shape: an ESM package
// outside this one, with its source under `src/`, reaching this package through its own `node_modules` and the export
// map, without the `elmera-source` condition. From inside this package, or from sources next to `node_modules`, the
// checker names the chunk by a relative path and passes whatever the declarations say.
it("a consumer's inferred wrappers around /next's and /start's useLocaleSwitch each emit their own host's LocaleSwitch", () => {
  const consumer = mkdtempSync(join(tmpdir(), "intl-declaration-emit-"));
  onTestFinished(() => {
    rmSync(consumer, { recursive: true, force: true });
  });
  mkdirSync(join(consumer, "src"));
  mkdirSync(join(consumer, "node_modules", ...manifest.name.split("/").slice(0, -1)), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("..", import.meta.url)),
    join(consumer, "node_modules", manifest.name),
    "dir"
  );
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: "src",
        outDir: "out",
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    })
  );
  writeFileSync(
    join(consumer, "src", "hooks.ts"),
    `import { useLocaleSwitch as useNextLocaleSwitch } from "${manifest.name}/next";
import { useLocaleSwitch as useStartLocaleSwitch } from "${manifest.name}/start";
export const useAppNextLocaleSwitch = () => useNextLocaleSwitch(async (_locale: string): Promise<void> => {});
export const useAppStartLocaleSwitch = () => useStartLocaleSwitch(async (_locale: string): Promise<void> => {});
`
  );

  // The installed compiler's own launcher, run on this Node: no `node_modules/.bin` on PATH is needed, so the test
  // runs the same under turbo, pnpm or Vitest started directly.
  const { status, stdout, error } = spawnSync(process.execPath, [TSRS, "-p", "tsconfig.json"], {
    cwd: consumer,
    encoding: "utf8",
    // A hang guard only: the compiler exits once it has emitted.
    timeout: 30_000,
  });

  expect({ status, stdout, error }).toEqual({ status: 0, stdout: "", error: undefined });
  const emitted = readFileSync(join(consumer, "out", "hooks.d.ts"), "utf8");
  expect(emitted).toContain(`useAppNextLocaleSwitch: () => import("${manifest.name}/next").LocaleSwitch;`);
  expect(emitted).toContain(`useAppStartLocaleSwitch: () => import("${manifest.name}/start").LocaleSwitch;`);
});
