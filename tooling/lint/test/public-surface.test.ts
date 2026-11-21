import { publicSurface } from "../src/rules/public-surface.ts";
import { createTester, fixture } from "./rule-tester.ts";

// Unit under test: elmera-workspace/public-surface. Oracle: fixtures/runtime's manifest and committed surface
// (`./core`: createIntl, msg; `./react`: T, useT, for both the default and the react-server source; `./unlisted` has
// no entry; `./internal/*` is unchecked): an entry module's runtime exports must equal its subpath's list.
createTester().run("public-surface", publicSurface, {
  valid: [
    {
      code: `export { createIntl, msg, type Catalog } from "./intl";\nexport type { Format } from "./format";`,
      filename: fixture("runtime/src/core.ts"),
    },
    {
      code: `export function T() {}\nexport const useT = () => 1;\nexport type TProps = {};\nexport interface X {}`,
      filename: fixture("runtime/src/react.tsx"),
    },
    { code: `export { T, useT } from "./server-react";`, filename: fixture("runtime/src/react-server.tsx") },
    {
      code: `export const hashKey = 1;\nexport * from "./other";`,
      filename: fixture("runtime/src/message.ts"),
    },
    // Not an entry module.
    { code: `export const anything = 1;`, filename: fixture("runtime/src/intl.ts") },
  ],
  invalid: [
    {
      code: `export { createIntl, msg, keyOf } from "./intl";`,
      filename: fixture("runtime/src/core.ts"),
      errors: [
        {
          messageId: "extra",
          data: { name: "keyOf", subpath: "./core", file: "test/public-surface.json" },
          column: 26,
        },
      ],
    },
    {
      code: `export { createIntl } from "./intl";`,
      filename: fixture("runtime/src/core.ts"),
      errors: [
        { messageId: "missing", data: { name: "msg", subpath: "./core", file: "test/public-surface.json" } },
      ],
    },
    {
      code: `export { T } from "./t";\nexport default function useT() {}`,
      filename: fixture("runtime/src/react-server.tsx"),
      // Sorted by position: the missing name reports at the top of the module.
      errors: [
        {
          messageId: "missing",
          data: { name: "useT", subpath: "./react", file: "test/public-surface.json" },
        },
        {
          messageId: "extra",
          data: { name: "default", subpath: "./react", file: "test/public-surface.json" },
        },
      ],
    },
    {
      code: `export * from "./intl";`,
      filename: fixture("runtime/src/core.ts"),
      errors: [{ messageId: "exportAll" }, { messageId: "missing" }, { messageId: "missing" }],
    },
    {
      code: `export const x = 1;`,
      filename: fixture("runtime/src/unlisted.ts"),
      errors: [{ messageId: "unlisted", data: { subpath: "./unlisted", file: "test/public-surface.json" } }],
    },
  ],
});
