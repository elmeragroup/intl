import { globalNames } from "../src/rules/global-names.ts";
import { createTester, fixture } from "./rule-tester.ts";

// Unit under test: elmera-workspace/global-names. Oracle: the global-namespace contract per case: a lint plugin's
// name, a Symbol.for key, a custom HMR event, and (in published src) a `*_EVENT`/`*_FILE` string constant start with
// `elmera-`.
createTester().run("global-names", globalNames, {
  valid: [
    // Vite's own HMR events keep Vite's names: a renamed listener would never fire.
    {
      code: `import.meta.hot?.on("vite:beforeUpdate", () => {});\nimport.meta.hot?.on("vite:ws:disconnect", () => {});`,
      filename: "vite-events.ts",
    },
    { code: `export default { meta: { name: "elmera-intl" }, rules: {} };`, filename: "a.ts" },
    { code: `export const key = Symbol.for("elmera.intl.key");`, filename: "b.ts" },
    { code: `import.meta.hot?.on("elmera-intl:catalog", () => {});`, filename: "c.ts" },
    { code: `server.hot.send({ type: "custom", event: "elmera-intl:catalog" });`, filename: "d.ts" },
    {
      code: `export const CONFIG_FILE = "elmera-intl.json";\nexport const CATALOG_UPDATE_EVENT = "elmera-intl:catalog";`,
      filename: fixture("tools/src/project.ts"),
    },
    // Outside published src a `*_FILE` constant is an ordinary path; and an imported name is scoped by its specifier.
    { code: `const PROBE_FILE = "src/probe.tsx";`, filename: fixture("tools/test/watch.test.ts") },
    {
      code: `export const rule = { meta: { type: "problem" }, create() {} };\nexport function intl() {}`,
      filename: "e.ts",
    },
  ],
  invalid: [
    // Only the events Vite declares are Vite's: another name under `vite:` is not.
    {
      code: `import.meta.hot?.on("vite:catalog", () => {});`,
      filename: "vite-custom.ts",
      errors: [{ messageId: "prefix" }],
    },
    {
      code: `export default { meta: { name: "intl" }, rules: {} };`,
      filename: "f.ts",
      errors: [
        {
          messageId: "prefix",
          data: { value: "intl", what: "a lint plugin's name, the prefix of its rule ids" },
        },
      ],
    },
    {
      code: `export const key = Symbol.for("intl.key");`,
      filename: "g.ts",
      errors: [{ messageId: "prefix" }],
    },
    {
      code: `import.meta.hot?.on("catalog-update", () => {});`,
      filename: "h.ts",
      errors: [{ messageId: "prefix", data: { value: "catalog-update", what: "a custom HMR event" } }],
    },
    {
      code: `server.hot.send({ type: "custom", event: "intl:catalog" });`,
      filename: "i.ts",
      errors: [{ messageId: "prefix" }],
    },
    {
      code: `export const CONFIG_FILE = "intl.json";`,
      filename: fixture("tools/src/project.ts"),
      errors: [{ messageId: "prefix" }],
    },
  ],
});
