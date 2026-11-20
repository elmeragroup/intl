import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { expect, it } from "vitest";

// Lint sees imports one file at a time; what reaches a browser is the bundle. Bundling the client entry from source
// for the browser, with every third-party package left external, lists exactly the packages it pulls in, so a
// tools module (parser, PO, filesystem) reached through any chain of runtime files shows up here.
const PARSE_TIME = [/^@elmeragroup\/intl-tools/, /^oxc-/, /^@oxc-/, /^po-parser$/, /^node:/];

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
// The framework peers an app provides; everything else a built entry reaches is bundled, as an app's bundler would.
const PEERS = /^(?:react|react-dom|next|@tanstack\/react-router)(?:\/|$)/;

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
] as const)("bundles %s with parser error codes %j", async (entry, expected) => {
  const code = await bundledCode(fileURLToPath(new URL(`../${entry}`, import.meta.url)));
  expect(PARSER_ERROR_CODES.filter((codeName) => code.includes(codeName))).toEqual(expected);
});
