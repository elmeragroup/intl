import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

import { formatPo } from "../src/po";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DIST = new URL("../dist/", import.meta.url).href;

// Records every module a fresh Node loads (import or require, at startup or on first use) while it imports the built
// entry and runs it once as its host does, then prints the URLs and what the run returned. argv: entry URL, host,
// project root.
const RECORD_RUN = `
import { registerHooks } from "node:module";
import { join } from "node:path";
const loaded = [];
registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
const [entry, host, root] = process.argv.slice(1);
const module = await import(entry);
let result;
if (host === "loader") {
  const { promise, resolve } = Promise.withResolvers();
  module.default.call(
    {
      resourcePath: join(root, "messages/nb.po"),
      getOptions: () => ({ config: join(root, "elmera-intl.json"), source: false }),
      addDependency: () => undefined,
      async: () => (error, code) => resolve(error === null ? code : "error: " + error.message),
    },
    (await import("node:fs")).readFileSync(join(root, "messages/nb.po"), "utf8")
  );
  result = await promise;
} else {
  const config = module.withIntl({ turbopack: { root } }, { dir: root });
  result = JSON.stringify(Object.keys(config.turbopack.rules));
}
process.stdout.write(JSON.stringify({ loaded, result }));
`;

/** What running a built entry once loaded, as Node loads it: every import and require, eager or lazy. */
type HostRun = {
  /** The package's own source modules the loaded chunks were built from (their source maps' `sources`). */
  readonly sources: ReadonlyArray<string>;
  /** Every other module loaded: Node built-ins and other packages' files, by URL. */
  readonly foreign: ReadonlyArray<string>;
  /** What the run produced: the loader's module code (or its error), or withIntl's rule keys. */
  readonly result: string;
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-load-graph-"));
  writeFileSync(
    join(root, "elmera-intl.json"),
    JSON.stringify({ include: ["src/**/*.ts"], catalogs: "messages/{locale}.po", locales: ["nb"] })
  );
  mkdirSync(join(root, "messages"));
  writeFileSync(
    join(root, "messages/nb.po"),
    formatPo("nb", [
      { source: "Hello", context: undefined, translation: "Hei", references: [], comments: [], flags: [] },
    ])
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(entry: string, host: "loader" | "next"): HostRun {
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", RECORD_RUN, `${DIST}${entry}`, host, root],
    { cwd: PACKAGE, encoding: "utf8" }
  );
  // SAFETY: RECORD_RUN prints exactly this shape.
  const { loaded, result } = JSON.parse(output) as {
    readonly loaded: ReadonlyArray<string>;
    readonly result: string;
  };
  const sources = loaded
    .filter((url) => url.startsWith(DIST))
    .flatMap((url) => {
      // SAFETY: tsdown writes a source map beside every chunk, whose `sources` are paths relative to the chunk.
      const { sources: chunkSources } = JSON.parse(readFileSync(`${fileURLToPath(url)}.map`, "utf8")) as {
        readonly sources: ReadonlyArray<string>;
      };

      return chunkSources.map((source) => relative(PACKAGE, fileURLToPath(new URL(source, url))));
    });

  return {
    sources: [...new Set(sources)].toSorted(),
    foreign: loaded.filter((url) => !url.startsWith(DIST)),
    result,
  };
}

// Unit under test: what Node loads for the built po-loader compiling one catalog. Oracle: the loader runs in every
// Turbopack and webpack loader worker, which must not load the CLI, its commands or the watcher.
it("compiles a catalog in the loader without loading the CLI, its commands or the watcher", () => {
  const { sources, result } = run("po-loader.js", "loader");

  // The control: the compile ran to its module, so the recording covers it.
  expect(result).toMatch(/^export default /u);
  expect(sources).toContain("src/po-loader.ts");
  expect(sources.filter((source) => /^src\/(?:cli-run|commands|watch)\.ts$/u.test(source))).toEqual([]);
});

// Unit under test: what Node loads for the built `./next` entry and one withIntl call. Oracle: Next loads next.config
// in several processes, and withIntl reads only the config: no extractor, no oxc native binding, no Effect.
it("adds the rule with withIntl without loading the extractor, oxc or Effect", () => {
  const { sources, foreign, result } = run("next.js", "next");

  expect(result).toBe('["*.po"]');
  expect(sources).toContain("src/next.ts");
  expect(sources.filter((source) => /^src\/(?:extract[\w-]*|bindings|scopes)\.ts$/u.test(source))).toEqual(
    []
  );
  expect(foreign.filter((url) => /\/(?:oxc-parser|oxc-transform|effect)\//u.test(url))).toEqual([]);
});
