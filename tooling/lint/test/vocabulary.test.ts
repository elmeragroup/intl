import { vocabulary } from "../src/rules/vocabulary.ts";
import { createTester } from "./rule-tester.ts";

// Unit under test: elmera-workspace/vocabulary. Oracle: the vocabulary contract per case: a declared name never spells
// i18n and never is `Intl` (which shadows the global); uses of foreign names and of the global itself are not
// declarations.
createTester().run("vocabulary", vocabulary, {
  valid: [
    {
      code: `export type IntlInstance = { readonly locale: string };\nexport const intl = 1;`,
      filename: "a.ts",
    },
    { code: `export const format = new Intl.NumberFormat("en");`, filename: "b.ts" },
    // A reference or a property is not a declaration, and a string is not a name.
    { code: `export const x = (globalThis as { i18n?: string }).i18n ?? "i18n";`, filename: "c.ts" },
  ],
  invalid: [
    {
      code: `export function createI18n() {}`,
      filename: "d.ts",
      errors: [{ messageId: "i18n", data: { name: "createI18n" } }],
    },
    { code: `export type I18nConfig = string;`, filename: "e.ts", errors: [{ messageId: "i18n" }] },
    {
      code: `import { useTranslation as useI18n } from "x";\nuseI18n();`,
      filename: "f.ts",
      errors: [{ messageId: "i18n" }],
    },
    { code: `export const { i18n } = { i18n: 1 };`, filename: "g.ts", errors: [{ messageId: "i18n" }] },
    {
      code: `export function f(i18n: string) { return i18n; }`,
      filename: "h.ts",
      errors: [{ messageId: "i18n" }],
    },
    {
      code: `export type Intl = { readonly locale: string };`,
      filename: "i.ts",
      errors: [{ messageId: "shadowsIntl" }],
    },
    { code: `export class Intl {}`, filename: "j.ts", errors: [{ messageId: "shadowsIntl" }] },
    { code: `const x = 1;\nexport { x as Intl };`, filename: "k.ts", errors: [{ messageId: "shadowsIntl" }] },
    {
      code: `export function f<Intl>(value: Intl) { return value; }`,
      filename: "l.ts",
      errors: [{ messageId: "shadowsIntl" }],
    },
  ],
});
