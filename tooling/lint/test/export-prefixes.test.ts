import { exportPrefixes } from "../src/rules/export-prefixes.ts";
import { createTester, fixture } from "./rule-tester.ts";

// Unit under test: elmera-workspace/export-prefixes. Oracle: the prefix contract per case: in a published package's
// src, an exported `use*` calls a hook, `get*` returns a Promise from a server module, `configure*` lives in a server
// module, and `compile*` lives in the tools. Outside published src the prefixes promise nothing.
createTester().run("export-prefixes", exportPrefixes, {
  valid: [
    // A re-export that keeps its prefix class is checked where it is declared.
    {
      code: `export { getT, getIntl as getInstance } from "./server";`,
      filename: fixture("runtime/src/next-server.ts"),
    },
    {
      code: `async function getThing(): Promise<number> {\n  return 1;\n}\nexport { getThing };`,
      filename: fixture("runtime/src/server.ts"),
    },
    // A concise arrow whose body is the hook call itself.
    {
      code: `export const useValue = () => useMemo(() => 1, []);`,
      filename: fixture("runtime/src/value.ts"),
    },
    { code: `export const useLocale = () => useIntl();`, filename: fixture("runtime/src/locale.ts") },
    {
      code: `import { use } from "react";\nexport function useT() { return use(Context); }`,
      filename: fixture("runtime/src/react.tsx"),
    },
    {
      code: `export const useLatest = (value: number) => { const ref = useRef(value); return ref; };`,
      filename: fixture("runtime/src/latest.ts"),
    },
    {
      code: `export async function getT(): Promise<string> { return ""; }`,
      filename: fixture("runtime/src/server.ts"),
    },
    // React's cache wraps the async function, and the binding's type says Promise.
    {
      code: `export const getIntl: () => Promise<number> = cache(async () => 1);`,
      filename: fixture("runtime/src/server.ts"),
    },
    {
      code: `export function getRequest(): Promise<number> { return Promise.resolve(1); }`,
      filename: fixture("runtime/src/next-server.ts"),
    },
    { code: `export function configureServer(): void {}`, filename: fixture("runtime/src/next-server.ts") },
    {
      code: `export function compileCatalog(): string { return ""; }`,
      filename: fixture("tools/src/compile.ts"),
    },
    // Not shipped source: a test helper or an app may name things as it likes.
    { code: `export function getNumberFormat() { return 1; }`, filename: fixture("runtime/test/helpers.ts") },
    { code: `export function useNothing() { return 1; }`, filename: fixture("app/src/a.ts") },
  ],
  invalid: [
    // A specifier export is checked as its exported name, against the declaration it names.
    {
      code: `function getThing() {\n  return 1;\n}\nexport { getThing };`,
      filename: fixture("runtime/src/thing.ts"),
      errors: [{ messageId: "getAsync" }, { messageId: "server" }],
    },
    {
      code: `const implementation = () => 1;\nexport { implementation as useThing };`,
      filename: fixture("runtime/src/thing.ts"),
      errors: [{ messageId: "hook", data: { name: "useThing" } }],
    },
    // A re-export keeps its source name's prefix class, and the re-exporting module answers for where it exports.
    {
      code: `export { createIntl as getThing } from "./intl";`,
      filename: fixture("runtime/src/server.ts"),
      errors: [{ messageId: "renamed", data: { name: "getThing", source: "createIntl" } }],
    },
    {
      code: `export { getT } from "./server";`,
      filename: fixture("runtime/src/core.ts"),
      errors: [{ messageId: "server", data: { name: "getT", prefix: "get" } }],
    },
    {
      code: `import { compileCatalog } from "./compile";\nexport { compileCatalog };`,
      filename: fixture("runtime/src/core.ts"),
      errors: [{ messageId: "compiler" }],
    },
    {
      code: `export function useLocale() { return "en"; }`,
      filename: fixture("runtime/src/locale.ts"),
      errors: [{ messageId: "hook", data: { name: "useLocale" } }],
    },
    // A hook called only inside a nested callback does not make the outer function a hook.
    {
      code: `export function useLater() { return () => useMemo(() => 1, []); }`,
      filename: fixture("runtime/src/later.ts"),
      errors: [{ messageId: "hook" }],
    },
    {
      code: `export const useValue = 1;`,
      filename: fixture("runtime/src/value.ts"),
      errors: [{ messageId: "hook" }],
    },
    {
      code: `export function getNumberFormat(): number { return 1; }`,
      filename: fixture("runtime/src/icu.ts"),
      errors: [
        { messageId: "getAsync" },
        { messageId: "server", data: { name: "getNumberFormat", prefix: "get" } },
      ],
    },
    {
      code: `export async function getT(): Promise<string> { return ""; }`,
      filename: fixture("runtime/src/react.tsx"),
      errors: [{ messageId: "server", data: { name: "getT", prefix: "get" } }],
    },
    {
      code: `export function getT(): string { return ""; }`,
      filename: fixture("runtime/src/server.ts"),
      errors: [{ messageId: "getAsync" }],
    },
    {
      code: `export function configureServer(): void {}`,
      filename: fixture("runtime/src/core.ts"),
      errors: [{ messageId: "server", data: { name: "configureServer", prefix: "configure" } }],
    },
    {
      code: `export function compileMessage(): string { return ""; }`,
      filename: fixture("runtime/src/compile.ts"),
      errors: [{ messageId: "compiler" }],
    },
  ],
});
