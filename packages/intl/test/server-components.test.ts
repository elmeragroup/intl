import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { compiled } from "./catalogs";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
// Next's copy of React's server components renderer and its client, which server components render with.
const FLIGHT = "next/dist/compiled/react-server-dom-webpack";

// A catalog with the outer message's key, which any `<T>a <b>b</b> c</T>` provides: positional tags erase the element
// (with no entry, the outer message would fall back as not extracted, translated or not); and the inner message's,
// so the inner `<T>` is seen translating itself.
const CATALOG = compiled("nb", { "a <x0>b</x0> c": "A<x0> B </x0>C", b: "innermelding" });

// What a host's build does for a server component, as module hooks: withIntl's alias of the request module to the
// app's `intl/request.ts` (here serving CATALOG), the "use client" boundary, which hands the server a client
// reference for the provider's module instead of running it, and, in both processes, Next's alias of `react` and
// `react-dom` to its own copies beside FLIGHT, so the elements, the built `/react` and the renderer share one React
// whichever version the app installed.
const REQUEST_MODULE = `export default () => Promise.resolve(${JSON.stringify({ locale: "nb", catalog: CATALOG, timeZone: "UTC" })});`;
const CLIENT_REFERENCE = `export const IntlProvider = () => { throw new Error("a client reference rendered on the server"); };`;

// Next's copies of React, by each specifier the scripts, the built `/react`, FLIGHT and those copies import: the files
// `createVendoredReactAliases` (`next/dist/build/create-compiler-aliases.js`) gives the edge layers, whose FLIGHT
// builds the scripts render with, `react-server`'s for the server process and the client's for the client (Next's Node
// layers alias to its prebuilt server runtime instead, which a plain process cannot load alone). `react-dom/server` is
// the Node build of Next's copy, since Next's own alias withholds the `renderToStaticMarkup` the client renders with.
// Next's copies require each other by their directories, which Node resolves to the default files, so the server
// aliases those too.
const REACT = "next/dist/compiled/react";
const REACT_DOM = "next/dist/compiled/react-dom";
const SERVER_REACT = {
  react: `${REACT}/react.react-server.js`,
  "react/jsx-runtime": `${REACT}/jsx-runtime.react-server.js`,
  "react-dom": `${REACT_DOM}/react-dom.react-server.js`,
  [REACT]: `${REACT}/react.react-server.js`,
  [REACT_DOM]: `${REACT_DOM}/react-dom.react-server.js`,
};
const CLIENT_REACT = {
  react: `${REACT}/index.js`,
  "react/jsx-runtime": `${REACT}/jsx-runtime.js`,
  "react-dom": `${REACT_DOM}/index.js`,
  "react-dom/server": `${REACT_DOM}/server.node.js`,
};

// Module hooks resolving each of `aliases` to its target, and each of `modules` to the source that replaces it.
const hooks = (aliases: Readonly<Record<string, string>>, modules: Readonly<Record<string, string>>) =>
  `import { registerHooks } from "node:module";
const aliases = ${JSON.stringify(aliases)};
const modules = ${JSON.stringify(modules)};
registerHooks({
  resolve(specifier, context, next) {
    const source = modules[specifier];
    return source === undefined
      ? next(aliases[specifier] ?? specifier, context)
      : { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  },
});
`;

// The server half: `<T>a <T>b</T> c</T>` from `/react`, as the package's export map resolves it under `react-server`,
// rendered to the server components payload.
const SERVER = `${hooks(SERVER_REACT, {
  [`${manifest.name}/internal/request-module`]: REQUEST_MODULE,
  [`${manifest.name}/internal/react-client`]: CLIENT_REFERENCE,
})}const { createElement } = await import("react");
const { renderToReadableStream } = await import("${FLIGHT}/server.edge.js");
const { T } = await import("${manifest.name}/react");
const message = createElement(T, null, "a ", createElement(T, null, "b"), " c");
process.stdout.write(await new Response(renderToReadableStream(message)).text());`;

// The client half: the payload read back and rendered to HTML, as a browser's first paint gets it.
const CLIENT = `${hooks(CLIENT_REACT, {})}const { createFromReadableStream } = await import("${FLIGHT}/client.edge.js");
const { renderToStaticMarkup } = await import("react-dom/server");
const payload = new Response(await new Response(process.stdin).text()).body;
const manifest = { serverConsumerManifest: { moduleMap: {}, serverModuleMap: null, moduleLoading: null } };
process.stdout.write(renderToStaticMarkup(await createFromReadableStream(payload, manifest)));`;

// A cold Node process is about 0.2 s on an idle machine; under extreme load one has taken past Vitest's default 5 s
// (load-graph.test.ts). Hang guards only, not waits: each spawn's, and the test's, which covers both spawns in turn.
const SPAWN_TIMEOUT = 25_000;
const TEST_TIMEOUT = 2 * SPAWN_TIMEOUT + 10_000;

function run(flags: ReadonlyArray<string>, script: string, input?: string) {
  return spawnSync(process.execPath, [...flags, "--input-type=module", "--eval", script], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    input,
    // An empty environment: no NODE_OPTIONS (Vitest's, or the source condition the lint script sets) reaches it.
    env: {},
    // A hang guard only: each process exits once it has written its output.
    timeout: SPAWN_TIMEOUT,
  });
}

// Unit under test: the built server `<T>`, reached as a server component reaches it: a plain Node process under the
// `react-server` condition resolving `/react` through the export map (no Vitest alias), rendered by React's server
// components renderer, its payload rendered to HTML by a second process without the condition. Oracle: the children
// as written, the inner `<T>` translated by its own entry; translated, the inner `<T>` would get the outer
// translation's text and render `ABC`. A server component
// has no `onError` to report to (#100), so the render is the assertion.
it(
  "the server <T>, rendered as a server component, renders a <T> inside it as written, the inner <T> translated",
  () => {
    const server = run(["--conditions=react-server"], SERVER);
    expect({ status: server.status, stderr: server.stderr }).toEqual({ status: 0, stderr: "" });

    const client = run([], CLIENT, server.stdout);
    expect({ status: client.status, stderr: client.stderr, html: client.stdout }).toEqual({
      status: 0,
      stderr: "",
      html: "a innermelding c",
    });
  },
  TEST_TIMEOUT
);
