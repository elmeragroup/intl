import { noUsing } from "../src/rules/no-using.ts";
import { createTester } from "./rule-tester.ts";

// Unit under test: elmera-workspace/no-using. Oracle: the declaration kinds ES2022 lacks: a `using` or `await using`
// declaration, at the top level, in a block or in a for…of head, is reported; `var`, `let` and `const`, and an
// identifier named `using`, are not.
createTester().run("no-using", noUsing, {
  valid: [
    {
      code: `const values = new Set([1]);\nlet first;\nfor (const value of values) { first = value; break; }\nexport { first };`,
      filename: "a.ts",
    },
    { code: `const using = 1;\nexport var total = using + 1;`, filename: "b.ts" },
  ],
  invalid: [
    {
      code: `export function first(values: Set<number>) { using candidates = values.values(); return candidates.next(); }`,
      filename: "c.ts",
      errors: [{ messageId: "using", data: { kind: "using" } }],
    },
    {
      code: `export async function close(open: () => AsyncDisposable) { await using resource = open(); }`,
      filename: "d.ts",
      errors: [{ messageId: "using", data: { kind: "await using" } }],
    },
    {
      code: `export function each(items: Iterable<Disposable>) { for (using item of items) { void item; } }`,
      filename: "e.ts",
      errors: [{ messageId: "using", data: { kind: "using" } }],
    },
  ],
});
