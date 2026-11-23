import { fileURLToPath } from "node:url";
import type { RolldownOutput } from "rolldown";
import { rolldown } from "rolldown";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };

const SELF = `${manifest.name}/`;
const EFFECT = /^effect(?:\/|$)/u;

// Lint sees imports one file at a time; what reaches a browser is the bundle. Bundling the client entry from source
// for the browser, with every third-party package left external, lists exactly the packages it pulls in, so a
// tools module (parser, PO, filesystem) reached through any chain of runtime files shows up here. `effect` is the
// tools' PO codec and the optional peer of `/effect` only.
const PARSE_TIME = [/^@elmeragroup\/intl-tools/u, /^oxc-/u, /^@oxc-/u, EFFECT, /^node:/u];

// Every package but this one's own subpaths stays external.
const isExternal = (id: string): boolean =>
  !id.startsWith(".") && !id.startsWith("/") && !id.startsWith(SELF);

// The external imports of a bundle's chunks, by specifier: every import that names no chunk of its own.
function externalImports(output: RolldownOutput["output"]): ReadonlyArray<string> {
  const chunkFiles = new Set(output.map((file) => file.fileName));

  return output.flatMap((file) =>
    file.type === "chunk" ? [...file.imports, ...file.dynamicImports].filter((id) => !chunkFiles.has(id)) : []
  );
}

it("keeps parsers, PO and Node built-ins out of the browser bundle of /react", async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL("../src/react.tsx", import.meta.url)),
    platform: "browser",
    // The runtime's own specifiers resolve to source through its tsconfig paths, so their graph is bundled too.
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    external: isExternal,
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const packages = externalImports(output);

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

// The consumer condition sets a subpath's graph resolves under, as a bundler hands them to its resolver: a
// server-component layer (Next's RSC layer: server components, server actions, route handlers) adds `react-server`;
// client and SSR code do not. Neither lists `elmera-source`, so every self-specifier resolves to the built package.
const CONDITIONS = {
  default: ["import", "default"],
  "react-server": ["react-server", "import", "default"],
} as const;
type Condition = keyof typeof CONDITIONS;
const CONDITION_KEYS: ReadonlyArray<Condition> = ["default", "react-server"];

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SUBPATHS = Object.keys(manifest.exports);

// What a subpath reaches under a condition set, bundled from the package directory by its specifier as a consumer's
// bundler resolves it: Rolldown's own resolver walks the export map (whose order decides the branch a condition set
// takes), every self-specifier is followed into the built module it resolves to, and every other package stays
// external.
async function reach(subpath: string, condition: Condition) {
  const specifiers = new Set<string>();
  const bundle = await rolldown({
    input: `${SELF}${subpath.slice("./".length)}`,
    cwd: PACKAGE_DIR,
    platform: "neutral",
    logLevel: "silent",
    // The export map, not the tsconfig paths that map the runtime's specifiers to source.
    tsconfig: false,
    resolve: { conditionNames: [...CONDITIONS[condition]] },
    // Every import counts, used or not: Node loads a module's imports whether or not a bundler would drop them.
    treeshake: false,
    external: isExternal,
    plugins: [
      {
        name: "self-specifiers",
        // Records each self-specifier a module imports; the entry, which no module imports, is not one.
        resolveId(source, importer) {
          if (importer !== undefined && source.startsWith(SELF)) {
            specifiers.add(source);
          }

          return null;
        },
      },
    ],
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();

  return {
    entry: output.flatMap((file) =>
      file.type === "chunk" && file.isEntry && file.facadeModuleId !== null ? [file.facadeModuleId] : []
    )[0],
    modules: new Set(output.flatMap((file) => (file.type === "chunk" ? file.moduleIds : []))),
    external: new Set(externalImports(output)),
    specifiers,
  };
}

const REACH = new Map(
  await Promise.all(
    SUBPATHS.flatMap((subpath) =>
      CONDITION_KEYS.map(
        async (condition) => [`${subpath} ${condition}`, await reach(subpath, condition)] as const
      )
    )
  )
);

function reachOf(subpath: string, condition: Condition) {
  const reached = REACH.get(`${subpath} ${condition}`);

  if (reached === undefined) {
    throw new Error(`${subpath} under ${condition} was not bundled`);
  }

  return reached;
}

const REQUEST_CONFIG = `${SELF}internal/request-config`;
const REQUEST_MODULE = `${SELF}internal/request-module`;

// The subpaths, by condition, that may reach each server-only module; every other must not. `effect` is the optional
// peer of `/effect` alone, so an app that never imports `/effect` never needs it installed. The request config is read
// by `/server` and the server `/react`. The request module, which the host aliases to the app's request module (holding
// the app's adapter), and the react-server request config that imports it are reached under `react-server` only:
// client and SSR code that reached them would bundle the app's adapter, and `next/headers` with it. `next/headers`
// throws outside a request scope and belongs to `/next/server` alone.
const ALLOWED = {
  effect: new Set(["./effect default", "./effect react-server"]),
  requestConfig: new Set(["./server default", "./server react-server", "./react react-server"]),
  requestModule: new Set([
    "./server react-server",
    "./react react-server",
    "./internal/request-config react-server",
  ]),
  nextHeaders: new Set(["./next/server default", "./next/server react-server"]),
};

// The modules ALLOWED names by what their specifiers resolve to, never by a file name: the `/effect` entry, and the
// request config that `react-server` resolves `internal/request-config` to.
const EFFECT_ENTRY = reachOf("./effect", "default").entry;
const REQUEST_CONFIG_SERVER = reachOf("./internal/request-config", "react-server").entry;

// Control: the condition sets take effect. Under `react-server` the request config resolves to a module of its own,
// which the default set never resolves to; were they one, the table below could not tell the layers apart.
it("resolves the request config to its own module under react-server", () => {
  const client = reachOf("./internal/request-config", "default").entry;

  expect([REQUEST_CONFIG_SERVER, client]).toEqual([expect.any(String), expect.any(String)]);
  expect(REQUEST_CONFIG_SERVER).not.toBe(client);
});

// Unit under test: each subpath's import graph under each consumer condition set, as Rolldown's resolver follows it
// through the export map and the package's own specifiers, for every subpath the manifest lists (new ones included).
// Oracle: the server-only contracts above, as ALLOWED states them by hand per subpath and condition; the allowed cases
// are the positive controls, so a walk that stopped seeing a module, or stopped following a condition, would fail them.
it.each(SUBPATHS.flatMap((subpath) => CONDITION_KEYS.map((condition) => [subpath, condition] as const)))(
  "%s under %s reaches effect, the request config and module, and next/headers only where allowed",
  (subpath, condition) => {
    const { modules, external, specifiers } = reachOf(subpath, condition);
    const allowed = (contract: ReadonlySet<string>) => contract.has(`${subpath} ${condition}`);

    expect({
      effect: [...external].some((id) => EFFECT.test(id)),
      effectEntry: EFFECT_ENTRY !== undefined && modules.has(EFFECT_ENTRY),
      requestConfig: specifiers.has(REQUEST_CONFIG),
      requestModule: specifiers.has(REQUEST_MODULE),
      requestConfigServer: REQUEST_CONFIG_SERVER !== undefined && modules.has(REQUEST_CONFIG_SERVER),
      nextHeaders: external.has("next/headers"),
    }).toEqual({
      effect: allowed(ALLOWED.effect),
      effectEntry: allowed(ALLOWED.effect),
      requestConfig: allowed(ALLOWED.requestConfig),
      requestModule: allowed(ALLOWED.requestModule),
      requestConfigServer: allowed(ALLOWED.requestModule),
      nextHeaders: allowed(ALLOWED.nextHeaders),
    });
  }
);
