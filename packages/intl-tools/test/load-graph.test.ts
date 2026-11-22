import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

import { formatPo } from "../src/po";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DIST = new URL("../dist/", import.meta.url).href;

// Records every module a fresh Node loads (import or require, at startup or on first use) while it imports the built
// entry and runs it as its host does, then stops recording, checks what the run produced and prints both. argv: entry
// URL, host, project root.
// - loader: one compile of the nb catalog, then one compile under a malformed config (the ConfigInvalid path); the
//   compiled module is then imported and asked for "Hello", which the fixture translates as "Hei".
// - next: one withIntl call with an explicit Turbopack root; the result is the rule keys it added.
const RECORD_RUN = `
import { registerHooks } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const loaded = [];
let recording = true;
registerHooks({ load(url, context, nextLoad) { if (recording) loaded.push(url); return nextLoad(url, context); } });
const [entry, host, root] = process.argv.slice(1);
const module = await import(entry);
const compile = (config) => {
  const { promise, resolve } = Promise.withResolvers();
  module.default.call(
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
let result;
if (host === "loader") {
  const compiled = await compile("elmera-intl.json");
  const invalid = await compile("bad.json");
  recording = false;
  let hello = compiled.error;
  if (compiled.code !== undefined) {
    const { createIntl } = await import("@elmeragroup/intl/core");
    const { default: catalog } = await import("data:text/javascript," + encodeURIComponent(compiled.code));
    hello = createIntl({ locale: "nb", catalog, timeZone: "UTC" }).t("Hello");
  }
  // The problem's location and code; the parser's own message after "not JSON: " varies by Node version.
  result = { hello, invalid: (invalid.error ?? "compiled").split(": not JSON: ")[0] };
} else {
  const config = module.withIntl({ turbopack: { root } }, { dir: root });
  recording = false;
  result = Object.keys(config.turbopack.rules);
}
process.stdout.write(JSON.stringify({ loaded, result }));
`;

/** What running a built entry loaded, as Node loads it: every import and require, eager or lazy. */
type HostRun = {
  /** Every URL Node loaded. */
  readonly loaded: ReadonlyArray<string>;
  /**
   * Each loaded module as what it holds: a loaded chunk of this package by the sources its source map names (its own
   * modules and any third-party code bundled into it), every other module by its URL. A chunk without a map holds no
   * code (a generated re-export); the chunks it re-exports are loads of their own.
   */
  readonly modules: ReadonlyArray<string>;
  /** What the run produced (see RECORD_RUN). */
  readonly result: unknown;
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-load-graph-"));
  writeFileSync(
    join(root, "elmera-intl.json"),
    JSON.stringify({ include: ["src/**/*.ts"], catalogs: "messages/{locale}.po", locales: ["nb"] })
  );
  writeFileSync(join(root, "bad.json"), "{ not json");
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

function chunkSources(url: string): ReadonlyArray<string> {
  const map = `${fileURLToPath(url)}.map`;

  if (!existsSync(map)) {
    return [];
  }

  // SAFETY: tsdown writes a source map beside every chunk with code, whose `sources` are paths relative to the chunk.
  const { sources } = JSON.parse(readFileSync(map, "utf8")) as { readonly sources: ReadonlyArray<string> };

  return sources.map((source) => relative(PACKAGE, fileURLToPath(new URL(source, url))));
}

function run(entry: string, host: "loader" | "next"): HostRun {
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", RECORD_RUN, `${DIST}${entry}`, host, root],
    { cwd: PACKAGE, encoding: "utf8" }
  );
  // SAFETY: RECORD_RUN prints exactly this shape.
  const { loaded, result } = JSON.parse(output) as {
    readonly loaded: ReadonlyArray<string>;
    readonly result: unknown;
  };

  return {
    loaded,
    modules: [...new Set(loaded.flatMap((url) => (url.startsWith(DIST) ? chunkSources(url) : [url])))],
    result,
  };
}

// Unit under test: what Node loads for the built po-loader compiling one catalog and reporting one invalid config.
// Oracle: the loader runs in every Turbopack and webpack loader worker, which must not load the CLI, its commands or
// the watcher; the fixture's "Hello" is "Hei" in nb, and a malformed config is a ConfigInvalid problem.
it("compiles a catalog and reports an invalid config in the loader without loading the CLI", () => {
  const { loaded, modules, result } = run("po-loader.js", "loader");

  expect(loaded).toContain(`${DIST}po-loader.js`);
  expect(result).toEqual({
    hello: "Hei",
    invalid: `${join(root, "bad.json")}: ConfigInvalid`,
  });
  expect(modules.filter((module) => /(?:^|\/)src\/(?:cli-run|commands|watch)\.ts$/u.test(module))).toEqual(
    []
  );
});

// Unit under test: what Node loads for the built `./next` entry and one withIntl call. Oracle: Next loads next.config
// in several processes, and withIntl reads only the config: no extractor, no oxc native binding, no Effect, whether
// loaded as a package or bundled into a chunk.
it("adds the rule with withIntl without loading the extractor, oxc or Effect", () => {
  const { loaded, modules, result } = run("next.js", "next");

  expect(loaded).toContain(`${DIST}next.js`);
  expect(result).toEqual(["*.po"]);
  expect(
    modules.filter(
      (module) =>
        /(?:^|\/)src\/(?:extract[\w-]*|bindings|scopes)\.ts$/u.test(module) ||
        /\/(?:oxc-parser|oxc-transform|effect)\//u.test(module)
    )
  ).toEqual([]);
});
