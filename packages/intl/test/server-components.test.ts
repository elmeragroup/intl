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
// app's `intl/request.ts` (here serving CATALOG), and the "use client" boundary, which hands the server a client
// reference for the provider's module instead of running it.
const REQUEST_MODULE = `export default () => Promise.resolve(${JSON.stringify({ locale: "nb", catalog: CATALOG, timeZone: "UTC" })});`;
const CLIENT_REFERENCE = `export const IntlProvider = () => { throw new Error("a client reference rendered on the server"); };`;

// The server half: `<T>a <T>b</T> c</T>` from `/react`, as the package's export map resolves it under `react-server`,
// rendered to the server components payload.
const SERVER = `import { registerHooks } from "node:module";
const modules = {
  "${manifest.name}/internal/request-module": ${JSON.stringify(REQUEST_MODULE)},
  "${manifest.name}/internal/react-client": ${JSON.stringify(CLIENT_REFERENCE)},
};
registerHooks({
  resolve(specifier, context, next) {
    const source = modules[specifier];
    return source === undefined
      ? next(specifier, context)
      : { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  },
});
const { createElement } = await import("react");
const { renderToReadableStream } = await import("${FLIGHT}/server.edge.js");
const { T } = await import("${manifest.name}/react");
const message = createElement(T, null, "a ", createElement(T, null, "b"), " c");
process.stdout.write(await new Response(renderToReadableStream(message)).text());`;

// The client half: the payload read back and rendered to HTML, as a browser's first paint gets it.
const CLIENT = `const { createFromReadableStream } = await import("${FLIGHT}/client.edge.js");
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
