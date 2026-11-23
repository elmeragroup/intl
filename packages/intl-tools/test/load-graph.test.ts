import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { expect, test } from "vitest";

import { formatPo } from "../src/po";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

// Each probe runs in a fresh Node that records every module it loads (import or require, at startup or on first
// use) until the probe stops recording, then prints the recording and what the probe observed.
const RECORDER = `
import { registerHooks } from "node:module";
const loaded = [];
let recording = true;
registerHooks({ load(url, context, nextLoad) { if (recording) loaded.push(url); return nextLoad(url, context); } });
const stop = () => { recording = false; };
`;

// next.config's view: `@elmeragroup/intl-tools/next` resolved through the package's export map, as an app resolves
// it; one withIntl call on a valid config, one on a malformed one. Prints the rule keys, the loader the `*.po` rule
// names (its non-source rule), and the malformed config's diagnostic. argv: project root.
const NEXT_PROBE = `${RECORDER}
import { join } from "node:path";
const [root] = process.argv.slice(1);
const { withIntl } = await import("@elmeragroup/intl-tools/next");
const config = withIntl({ turbopack: { root } }, { dir: root });
let invalid = "accepted";
try {
  withIntl({ turbopack: { root } }, { dir: join(root, "bad-app") });
} catch (error) {
  // The parser's own message after "not JSON: " varies by Node version.
  invalid = error.message.replace(/^withIntl: not JSON: .*?; /u, "withIntl: not JSON: …; ");
}
stop();
const rules = config.turbopack.rules;
const rule = rules["*.po"].find((candidate) => !candidate.loaders[0].options.source);
process.stdout.write(JSON.stringify({ loaded, result: { keys: Object.keys(rules), invalid, loader: rule.loaders[0].loader } }));
`;

// A loader worker's view: the loader withIntl's rule names, loaded fresh; one compile of the nb catalog, one under a
// malformed config. The compiled module is then imported and asked for "Hello", which the fixture translates as "Hei".
// argv: loader path, project root.
const LOADER_PROBE = `${RECORDER}
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [loader, root] = process.argv.slice(1);
const { default: poLoader } = await import(pathToFileURL(loader).href);
const compile = (config) => {
  const { promise, resolve } = Promise.withResolvers();
  poLoader.call(
    {
      resourcePath: join(root, "messages/nb.po"),
      getOptions: () => ({ config: join(root, config), source: false }),
      addDependency: () => undefined,
      async: () => (error, code) => resolve(error === null ? { code } : { error: error.message }),
    },
    readFileSync(join(root, "messages/nb.po"), "utf8")
  );
  return promise;
};
const compiled = await compile("elmera-intl.json");
const invalid = await compile("bad.json");
stop();
let hello = compiled.error;
if (compiled.code !== undefined) {
  const { createIntl } = await import("@elmeragroup/intl/core");
  const { default: catalog } = await import("data:text/javascript," + encodeURIComponent(compiled.code));
  hello = createIntl({ locale: "nb", catalog, timeZone: "UTC" }).t("Hello");
}
// The problem's location and code; the parser's own message after "not JSON: " varies by Node version.
process.stdout.write(JSON.stringify({ loaded, result: { hello, invalid: (invalid.error ?? "compiled").split(": not JSON: ")[0] } }));
`;

// The Vitest global setup's view: `@elmeragroup/intl-tools/vitest` resolved through the package's export map, as an
// app's vitest config names it, run once on the project. Prints how it ended. argv: project root.
const VITEST_PROBE = `${RECORDER}
const [root] = process.argv.slice(1);
const { default: checkIntlCatalogs } = await import("@elmeragroup/intl-tools/vitest");
const imported = loaded.filter((url) => url.includes("platform-node-shared"));
process.stderr.write = () => true;
let outcome = "passed";
try {
  await checkIntlCatalogs({ config: { root } });
} catch (error) {
  outcome = error.message;
}
stop();
process.stdout.write(JSON.stringify({ loaded, result: { outcome, imported } }));
`;

/**
 * What a probe loaded, as what each module holds, and what it observed.
 *
 * @template T - The shape of what the probe observed.
 */
type ProbeRun<T> = {
  /**
   * Each loaded module as what it holds: a built file of this package by the sources its declared source map names
   * (its own modules and any third-party code bundled into it), every other module by its URL.
   */
  readonly modules: ReadonlyArray<string>;
  /** How many of this package's built files were inspected through their source maps. */
  readonly inspected: number;
  /** What the probe observed (see the probes). */
  readonly result: T;
};

// Each test owns its project (see `Project`): a valid config, a malformed one beside it and in `bad-app`, and an nb
// catalog translating "Hello" as "Hei". Every probe is killed at the project's deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-load-graph-", task.timeout);
  onCleanup(close);
  project.write(
    "elmera-intl.json",
    JSON.stringify({ include: ["src/**/*.ts"], catalogs: "messages/{locale}.po", locales: ["nb"] })
  );
  project.write("bad.json", "{ not json");
  project.write("bad-app/elmera-intl.json", "{ not json");
  project.write(
    "messages/nb.po",
    formatPo("nb", [
      { source: "Hello", context: undefined, translation: "Hei", references: [], comments: [], flags: [] },
    ])
  );

  return project;
});

// A probe is a fresh Node that loads a built entry cold and runs it once, about 0.2 s on an idle machine; under extreme
// load (load average 77) one has taken past Vitest's default 5 s. The timeout of a test that runs one or two of them,
// whose spawns the project's deadline still guards.
const PROBES = { timeout: 30_000 };

const SOURCE_MAPPING_URL = /\/\/# sourceMappingURL=(\S+)\s*$/u;

// Forwarding only: imports and re-exports, no statement that runs code of its own (tsdown's generated re-export
// chunks, such as a dynamic import's facade).
function forwardsOnly(file: string, code: string): boolean {
  return parseSync(file, code).program.body.every(
    (statement) =>
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" && statement.declaration === null)
  );
}

// The sources a built file holds, from the source map it declares: a sourceMappingURL comment naming a map file or
// carrying an inline `data:` map. A file declaring none must only forward; one whose map cannot be read fails.
function builtSources(url: string): ReadonlyArray<string> {
  const file = fileURLToPath(url);
  const code = readFileSync(file, "utf8");
  const declared = SOURCE_MAPPING_URL.exec(code)?.[1];

  if (declared === undefined) {
    if (!forwardsOnly(file, code)) {
      throw new Error(`${file} runs code but declares no source map, so what it bundles cannot be checked`);
    }

    return [];
  }

  const mapUrl = new URL(declared, url);
  let text: string;
  if (mapUrl.protocol === "data:") {
    // The whole body after the first comma: the payload may hold commas, `?` and `#`, which URL parts would split off.
    const body = mapUrl.href.slice("data:".length);
    const comma = body.indexOf(",");
    if (comma === -1) {
      throw new Error(`${file} declares an inline source map with no comma before its payload`);
    }
    const header = body.slice(0, comma);
    const payload = body.slice(comma + 1);
    text = header.endsWith(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } else if (existsSync(fileURLToPath(mapUrl))) {
    text = readFileSync(fileURLToPath(mapUrl), "utf8");
  } else {
    throw new Error(`${file} declares the source map ${declared}, which does not exist`);
  }

  // SAFETY: a source map's `sources` are paths or URLs relative to the map.
  const { sources } = JSON.parse(text) as { readonly sources: ReadonlyArray<string> };

  return sources.map((source) =>
    relative(PACKAGE, fileURLToPath(new URL(source, mapUrl.protocol === "data:" ? url : mapUrl)))
  );
}

function isBuiltFile(url: string): boolean {
  if (!url.startsWith("file:")) {
    return false;
  }

  const path = relative(PACKAGE, fileURLToPath(url));

  return !path.startsWith("..") && !path.split(sep).includes("node_modules");
}

function probe<T>(project: Project, script: string, args: ReadonlyArray<string>): ProbeRun<T> {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script, ...args], {
    cwd: PACKAGE,
    encoding: "utf8",
    ...project.spawnGuard(),
  });
  // SAFETY: each probe prints this shape, and each caller names the result its probe prints; the test's assertions on
  // the result fail on any other.
  const { loaded, result } = JSON.parse(output) as {
    readonly loaded: ReadonlyArray<string>;
    readonly result: T;
  };
  const built = loaded.filter((url) => isBuiltFile(url));

  return {
    modules: [
      ...new Set([
        ...built.flatMap((url) => builtSources(url)),
        ...loaded.filter((url) => !isBuiltFile(url)),
      ]),
    ],
    inspected: built.length,
    result,
  };
}

// Unit under test: the public `./next` entry, as an app's next.config resolves and calls it, and then the loader its
// rule names, in a fresh loader worker. Oracle: Next loads next.config in several processes, so withIntl loads no
// extractor, oxc native binding or Effect, on a valid config or a malformed one; the loader runs in every Turbopack
// and webpack worker, so it loads no CLI, commands (nor their catalog planning, checks or files), watcher, extractor or
// oxc, compiling or reporting. The fixture's "Hello" is "Hei"
// in nb, and a malformed config is a ConfigInvalid problem. The rule names the built loader beside the built `./next`
// entry, dist/po-loader.js, which the export map resolves to.
it(
  "keeps the extractor, oxc and Effect out of withIntl, and the CLI and the extractor out of the loader its rule names",
  PROBES,
  ({ project }) => {
    const next = probe<{
      readonly keys: ReadonlyArray<string>;
      readonly invalid: string;
      readonly loader: string;
    }>(project, NEXT_PROBE, [project.root]);
    const builtLoader = join(PACKAGE, "dist/po-loader.js");

    expect(next.result).toEqual({
      keys: ["*.po"],
      loader: builtLoader,
      invalid:
        'withIntl: not JSON: …; write elmera-intl.json as { "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb"], "formats": "src/intl-formats.ts" }',
    });
    expect(next.inspected).toBeGreaterThan(0);
    expect(
      next.modules.filter(
        (module) =>
          /(?:^|\/)src\/(?:extract[\w-]*|bindings|scopes)\.ts$/u.test(module) ||
          /\/(?:oxc-parser|oxc-transform|effect)\//u.test(module)
      )
    ).toEqual([]);

    const loader = probe(project, LOADER_PROBE, [next.result.loader, project.root]);

    expect(loader.result).toEqual({ hello: "Hei", invalid: `${project.path("bad.json")}: ConfigInvalid` });
    expect(loader.inspected).toBeGreaterThan(0);
    expect(
      loader.modules.filter(
        (module) =>
          /(?:^|\/)src\/(?:cli-run|commands|catalog-(?:plan|check|files)|watch|extract[\w-]*|bindings|scopes)\.ts$/u.test(
            module
          ) || /\/(?:oxc-parser|oxc-transform|@oxc-parser)\//u.test(module)
      )
    ).toEqual([]);
  }
);

// Unit under test: the public `./vitest` entry, as a Vitest global setup imports and runs it. Oracle: the setup runs
// `check` once per test run, so it pays for no argument parser: it loads neither effect/cli, nor the Node platform
// services only the executable uses (@effect/platform-node-shared's Stdio and Terminal), nor the CLI's parsing and
// watch modules. Importing it loads no platform module at all: check imports Node's file system and paths as it runs.
// The fixture's catalog holds "Hello", which no source declares, so check finds it stale.
it(
  "keeps effect/cli, the platform until check runs, and the watcher out of the Vitest setup",
  PROBES,
  ({ project }) => {
    const vitest = probe<{ readonly outcome: string; readonly imported: ReadonlyArray<string> }>(
      project,
      VITEST_PROBE,
      [project.root]
    );

    expect(vitest.result.outcome).toMatch(/^elmera-intl check found problems in /u);
    expect(vitest.inspected).toBeGreaterThan(0);
    expect(vitest.result.imported).toEqual([]);
    expect(
      vitest.modules.filter(
        (module) =>
          /(?:^|\/)src\/(?:cli-run|watch)\.ts$/u.test(module) ||
          /\/effect\/dist\/cli\/|\/@effect\/platform-node-shared\/dist\/Node(?:Stdio|Terminal|ChildProcessSpawner)\.js$/u.test(
            module
          )
      )
    ).toEqual([]);
    // Check did run on the platform, imported as it ran.
    expect(
      vitest.modules.some((module) => module.endsWith("/platform-node-shared/dist/NodeFileSystem.js"))
    ).toBe(true);
  }
);
