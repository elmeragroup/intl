import { sideEffectFree } from "../src/rules/side-effect-free.ts";
import { createTester, fixture } from "./rule-tester.ts";

const src = fixture("runtime/src/module.ts");

// Unit under test: elmera-workspace/side-effect-free. Oracle: the definition in the rule's header, per case: at the
// top level of a published package's src, only declarations and pure initializers run at import.
createTester().run("side-effect-free", sideEffectFree, {
  valid: [
    {
      code: [
        `"use client";`,
        `import { createContext } from "react";`,
        `export { x } from "./x";`,
        `export * from "./y";`,
        `export const VERSION = "1";`,
        `const CACHE = new Map<string, number>();`,
        `const RULES = new Intl.PluralRules("en");`,
        `const FORMAT = Symbol("elmera.intl.format");`,
        `const DATE = new Date(Date.UTC(2026, 0, 15));`,
        `const RANGE = /* @__PURE__ */ Array.from({ length: 3 }, (_, i) => i);`,
        `const TABLE = { a: [1, 2], b: \`x\${VERSION}\`, ...{ c: -1 } } as const satisfies Record<string, unknown>;`,
        `const Context = /* @__PURE__ */ createContext(null);`,
        `let resolver: (() => void) | undefined;`,
        `export class Failure extends Error { readonly _tag = "Failure"; static readonly code = 1; }`,
        `export function f() { console.log("at call time"); }`,
        `export type T = string;`,
        `declare const BRAND: unique symbol;`,
        `export default f;`,
      ].join("\n"),
      filename: src,
    },
    // Not published source: a test or an app runs what it likes at import.
    { code: `console.log("setup");\nimport "./polyfill";`, filename: fixture("runtime/test/setup.ts") },
    { code: `register();`, filename: fixture("app/src/main.ts") },
    // A callback whose body is a pure expression, a method body and an instance initializer run later, not at import.
    {
      code: `export const range = /* @__PURE__ */ Array.from({ length: 3 }, (_, i) => i * 2);\nexport class Lazy {\n  value = register();\n  ["key"]() {\n    return register();\n  }\n}`,
      filename: src,
    },
  ],
  invalid: [
    // Destructuring runs its defaults and computed keys at import.
    {
      code: `export const { value = console.log("x") } = {};`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export const { [register()]: value } = { a: 1 };`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    { code: `export const [first = register()] = [];`, filename: src, errors: [{ messageId: "impure" }] },
    {
      code: `export const { a: { b = register() } } = { a: {} };`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    // A call no list proves pure needs the annotation, even with a pure-looking callback: its parameter defaults and
    // body run inside the call.
    {
      code: `export const table = Array.from([1], (x = register()) => x);`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export const table = Array.from({ length: 3 }, (_, i) => i);`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    // A local binding that shadows a trusted global is not the global.
    {
      code: `class Map {\n  constructor() {\n    register();\n  }\n}\nexport const m = new Map();`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `const Symbol = (s: string) => register(s);\nexport const s = Symbol("x");`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `import { Intl } from "./polyfill";\nexport const rules = new Intl.PluralRules("en");`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    // A known-pure call still runs the callback it is given, and a computed class key runs at definition.
    {
      code: `export const table = Array.from({ length: 1 }, () => {\n  register();\n  return 1;\n});`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export const table = Array.from([1], () => register());`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export const table = Array.from([1], register);`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export class Registry {\n  [register()]() {\n    return 1;\n  }\n}`,
      filename: src,
      errors: [{ messageId: "statement" }],
    },
    {
      code: `export class Registry {\n  static [register()] = 1;\n}`,
      filename: src,
      errors: [{ messageId: "statement" }],
    },
    {
      code: `export class Registry {\n  [register()] = 1;\n}`,
      filename: src,
      errors: [{ messageId: "statement" }],
    },
    {
      code: `export class Registry {\n  get [register()]() {\n    return 1;\n  }\n}`,
      filename: src,
      errors: [{ messageId: "statement" }],
    },
    { code: `console.log("loaded");`, filename: src, errors: [{ messageId: "statement" }] },
    {
      code: `import "./register";`,
      filename: src,
      errors: [{ messageId: "bareImport", data: { specifier: "./register" } }],
    },
    {
      code: `import { createContext } from "react";\nconst Context = createContext(null);`,
      filename: src,
      errors: [{ messageId: "impure", line: 2 }],
    },
    { code: `export const config = readConfig();`, filename: src, errors: [{ messageId: "impure" }] },
    { code: `const list = [1, register()];`, filename: src, errors: [{ messageId: "impure" }] },
    {
      code: `declare const m: Map<string, number>;\nconst removed = delete m["k"];`,
      filename: src,
      errors: [{ messageId: "impure" }],
    },
    {
      code: `export class Registry { static instance = create(); }`,
      filename: src,
      errors: [{ messageId: "statement" }],
    },
    {
      code: `export class Boot { static { start(); } }`,
      filename: src,
      errors: [{ messageId: "staticBlock" }],
    },
    { code: `for (const x of []) {}`, filename: src, errors: [{ messageId: "statement" }] },
    { code: `export default start();`, filename: src, errors: [{ messageId: "impure" }] },
  ],
});
