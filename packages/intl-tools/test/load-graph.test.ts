import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DIST = new URL("../dist/", import.meta.url).href;

// Records every module a fresh Node loads to import the entry (argv[1]), and prints their URLs.
const RECORD_LOADS = `
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
await import(process.argv[1]);
process.stdout.write(JSON.stringify(loaded));
`;

/** What importing a built entry loads, as Node loads it: every import evaluated, used or not. */
type EntryGraph = {
  /** The package's own source modules the loaded chunks were built from (their source maps' `sources`). */
  readonly sources: ReadonlyArray<string>;
  /** Every other module loaded: Node built-ins and other packages' files, by URL. */
  readonly foreign: ReadonlyArray<string>;
};

function graphOf(entry: string): EntryGraph {
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", RECORD_LOADS, `${DIST}${entry}`],
    {
      cwd: PACKAGE,
      encoding: "utf8",
    }
  );
  // SAFETY: RECORD_LOADS prints a JSON array of URL strings.
  const loaded = JSON.parse(output) as ReadonlyArray<string>;
  const sources = loaded
    .filter((url) => url.startsWith(DIST))
    .flatMap((url) => {
      const map = `${fileURLToPath(url)}.map`;
      // SAFETY: tsdown writes a source map beside every chunk, whose `sources` are paths relative to the chunk.
      const { sources: chunkSources } = JSON.parse(readFileSync(map, "utf8")) as {
        readonly sources: ReadonlyArray<string>;
      };

      return chunkSources.map((source) => relative(PACKAGE, fileURLToPath(new URL(source, url))));
    });

  return {
    sources: [...new Set(sources)].toSorted(),
    foreign: loaded.filter((url) => !url.startsWith(DIST)),
  };
}

// Unit under test: what Node loads for the built po-loader. Oracle: the loader prints problems and compiles one
// catalog; it runs in every Turbopack and webpack loader worker, which must not load the CLI, its commands or the
// watcher.
it("keeps the CLI, its commands and the watcher out of the loader's graph", () => {
  const { sources } = graphOf("po-loader.js");

  expect(sources).toContain("src/po-loader.ts");
  expect(
    sources.filter((source) => ["src/cli-run.ts", "src/commands.ts", "src/watch.ts"].includes(source))
  ).toEqual([]);
});

// Unit under test: what Node loads for the built `./next` entry. Oracle: `withIntl` reads only the config, and Next
// loads next.config in several processes, so it loads exactly its own module and the config's, and no package but
// Node's built-ins (no extractor, no oxc native binding, no Effect).
it("loads only the config module with withIntl", () => {
  const { sources, foreign } = graphOf("next.js");

  expect(sources).toEqual(["src/next.ts", "src/project-config.ts"]);
  expect(foreign.filter((url) => !url.startsWith("node:"))).toEqual([]);
});
