import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };

// Lint sees imports one file at a time; what reaches a browser is the bundle. Bundling the client entry from source
// for the browser, with every third-party package left external, lists exactly the packages it pulls in, so a
// tools module (parser, PO, filesystem) reached through any chain of runtime files shows up here. `effect` is the
// tools' PO codec and the optional peer of `/effect` only.
const PARSE_TIME = [/^@elmeragroup\/intl-tools/u, /^oxc-/u, /^@oxc-/u, /^effect(?:\/|$)/u, /^node:/u];

it("keeps parsers, PO and Node built-ins out of the browser bundle of /react", async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL("../src/react.tsx", import.meta.url)),
    platform: "browser",
    // The runtime's own specifiers resolve to source through its tsconfig paths, so their graph is bundled too.
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@elmeragroup/intl/"),
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const chunkFiles = new Set(output.map((file) => file.fileName));
  const packages = output.flatMap((file) =>
    file.type === "chunk" ? [...file.imports, ...file.dynamicImports].filter((id) => !chunkFiles.has(id)) : []
  );

  expect(packages).toContain("react");
  expect(packages.filter((id) => PARSE_TIME.some((pattern) => pattern.test(id)))).toEqual([]);
});

// ErrorKind names only the parser's own module contains; no-parser.js has none of them.
const PARSER_ERROR_CODES = ["EXPECT_ARGUMENT_CLOSING_BRACE", "MALFORMED_ARGUMENT", "UNCLOSED_TAG"];
// The peers an app provides; everything else a built entry reaches is bundled, as an app's bundler would.
const PEERS = /^(?:react|react-dom|next|@tanstack\/react-router|effect)(?:\/|$)/u;

async function bundledCode(entry: string): Promise<string> {
  const bundle = await rolldown({ input: entry, platform: "browser", logLevel: "silent", external: PEERS });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();

  return output.map((file) => (file.type === "chunk" ? file.code : "")).join("\n");
}

// Unit under test: the built browser entries with everything they import (their own subpaths, intl-messageformat),
// as an app bundles them: the runtime formats compiled catalogs, so no parser may reach a browser. Control: the
// formatter's source, bundled the same way, carries the parser (from source intl-messageformat binds it at load).
it.each([
  ["src/formatter.ts", PARSER_ERROR_CODES],
  ["dist/react.js", []],
  ["dist/core.js", []],
  ["dist/start.js", []],
  ["dist/effect.js", []],
] as const)("bundles %s with parser error codes %j", async (entry, expected) => {
  const code = await bundledCode(fileURLToPath(new URL(`../${entry}`, import.meta.url)));
  expect(PARSER_ERROR_CODES.filter((codeName) => code.includes(codeName))).toEqual(expected);
});

const SELF = `${manifest.name}/`;
const EFFECT = /^effect(?:\/|$)/u;
// Each subpath's built module, and every built entry (the react-server branch of ./react included).
const BUILT = new Map(Object.entries(manifest.exports).map(([subpath, target]) => [subpath, target.import]));
const ENTRIES = [
  ...new Set(
    Object.values(manifest.exports).flatMap((target) => [
      ...("react-server" in target ? [target["react-server"].import] : []),
      target.import,
    ])
  ),
];

// A built entry's whole graph: its chunks and the package's own subpaths it imports (resolved through the export map,
// as Node resolves them), bundled; every other package stays an external import, listed by its specifier.
async function graphOf(
  entry: string
): Promise<{ readonly modules: ReadonlyArray<string>; readonly external: ReadonlyArray<string> }> {
  const bundle = await rolldown({
    input: fileURLToPath(new URL(`../${entry}`, import.meta.url)),
    platform: "neutral",
    logLevel: "silent",
    // Every import counts, used or not: Node loads a module's imports whether or not a bundler would drop them.
    treeshake: false,
    external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith(SELF),
    plugins: [
      {
        name: "self-specifiers",
        resolveId(id) {
          const file = id.startsWith(SELF) ? BUILT.get(`./${id.slice(SELF.length)}`) : undefined;

          return file === undefined ? null : fileURLToPath(new URL(`../${file}`, import.meta.url));
        },
      },
    ],
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const chunkFiles = new Set(output.map((file) => file.fileName));

  return {
    modules: output.flatMap((file) => (file.type === "chunk" ? file.moduleIds : [])),
    external: output.flatMap((file) =>
      file.type === "chunk"
        ? [...file.imports, ...file.dynamicImports].filter((id) => !chunkFiles.has(id))
        : []
    ),
  };
}

// Unit under test: each built entry's import graph, followed through its chunks and the package's own subpaths. Oracle:
// the optional-peer contract: `effect` is reached only from dist/effect.js, the `/effect` entry, which imports it as an
// external specifier, so an app that never imports `/effect` never needs `effect` installed.
it.each(ENTRIES)("%s reaches effect only if it is the /effect entry", async (entry) => {
  const { modules, external } = await graphOf(entry);
  const isEffectEntry = entry === "./dist/effect.js";

  expect(external.some((id) => EFFECT.test(id))).toBe(isEffectEntry);
  expect(modules.filter((id) => id.endsWith("/dist/effect.js"))).toEqual(
    isEffectEntry ? [fileURLToPath(new URL("../dist/effect.js", import.meta.url))] : []
  );
});
