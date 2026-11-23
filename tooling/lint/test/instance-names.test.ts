import { instanceNames } from "../src/rules/instance-names.ts";
import { createTester } from "./rule-tester.ts";

const effect = `import * as Effect from "effect/Effect";\nimport { CurrentIntl } from "@elmeragroup/intl/effect";\n`;
const pre = `import { createIntl, useFormat, useIntl, useT } from "@elmeragroup/intl/react";\nimport { getFormat, getIntl, getT } from "@elmeragroup/intl/server";\n`;

// Unit under test: elmera-workspace/instance-names. Oracle: the naming contract per case: what holds an IntlInstance
// is `intl`, a formatter `format`, a translator `t`, or a qualified name ending in that role (`nbIntl`).
createTester().run("instance-names", instanceNames, {
  valid: [
    // A binding read from itself (a TDZ error at run time) is not traced in circles.
    { code: `export const value = value.format;`, filename: "self.ts" },
    {
      code: `import { createIntl } from "@elmeragroup/intl/core";\nconst a = b.format;\nconst b = a.format;\nexport const intl = createIntl(config);\nexport { a, b };`,
      filename: "cycle.ts",
    },
    // A local factory of the same name, or one that shadows the import, is not the runtime's.
    {
      code: `function createIntl(): number { return 1; }\nexport const count = createIntl();`,
      filename: "local.ts",
    },
    {
      code: `${pre}export function f(useT: () => string) { const label = useT(); return label; }`,
      filename: "shadow.ts",
    },
    {
      code: `${pre}export function A() { const intl = useIntl(); const t = useT(); const format = useFormat(); return [intl, t, format]; }`,
      filename: "a.tsx",
    },
    {
      code: `${pre}export async function f() { const intl = await getIntl(); const t = await getT(); const format = await getFormat(); return [intl, t, format]; }`,
      filename: "b.ts",
    },
    {
      code: `${pre}const nbIntl = createIntl(config);\nconst enIntl = createIntl(config);\nexport const nbFormat = nbIntl.format;\nexport const x = [enIntl];`,
      filename: "c.ts",
    },
    // Destructuring names the fields themselves, and other values are not instances.
    {
      code: `${pre}export function A() { const { t, locale } = useIntl(); const other = useOther(); return [t, locale, other]; }`,
      filename: "d.tsx",
    },
    // `yield* CurrentIntl` reads an instance: `intl`, or `{ t }` destructured from it. A plain `yield` and another
    // service of the same name are not it.
    {
      code: `${effect}export const f = Effect.gen(function* () { const intl = yield* CurrentIntl; const { t } = yield* CurrentIntl; return [intl, t]; });`,
      filename: "effect.ts",
    },
    {
      code: `${effect}export const f = Effect.gen(function* () { const translator = yield CurrentIntl; return translator; });`,
      filename: "plain-yield.ts",
    },
    {
      code: `import * as Effect from "effect/Effect";\nimport { CurrentIntl } from "./services";\nexport const f = Effect.gen(function* () { const translator = yield* CurrentIntl; return translator; });`,
      filename: "other-service.ts",
    },
  ],
  invalid: [
    {
      code: `${effect}export const f = Effect.gen(function* () { const translator = yield* CurrentIntl; return translator; });`,
      filename: "translator.ts",
      errors: [
        {
          messageId: "rename",
          data: { name: "translator", source: "yield* CurrentIntl", role: "intl", suffix: "Intl" },
        },
      ],
    },
    // A renamed import is the same service, and `.format` read off what it yields is the formatter.
    {
      code: `import * as Effect from "effect/Effect";\nimport { CurrentIntl as Translator } from "@elmeragroup/intl/effect";\nexport const f = Effect.gen(function* () { const intl = yield* (Translator); const fmt = intl.format; return fmt; });`,
      filename: "renamed.ts",
      errors: [
        {
          messageId: "rename",
          data: { name: "fmt", source: "intl.format", role: "format", suffix: "Format" },
        },
      ],
    },
    // The runtime's factory under an alias is still the runtime's.
    {
      code: `import { createIntl as make } from "@elmeragroup/intl/core";\nexport const nb = make(config);`,
      filename: "alias.ts",
      errors: [
        { messageId: "rename", data: { name: "nb", source: "createIntl()", role: "intl", suffix: "Intl" } },
      ],
    },
    {
      code: `import * as server from "@elmeragroup/intl/server";\nexport async function f() { const i = await server.getIntl(); return i; }`,
      filename: "namespace.ts",
      errors: [
        { messageId: "rename", data: { name: "i", source: "getIntl()", role: "intl", suffix: "Intl" } },
      ],
    },
    {
      code: `${pre}export async function f() { const i = await getIntl(); return i; }`,
      filename: "e.ts",
      errors: [
        { messageId: "rename", data: { name: "i", source: "getIntl()", role: "intl", suffix: "Intl" } },
      ],
    },
    {
      code: `${pre}export const formatter = createIntl(config);`,
      filename: "f.ts",
      errors: [
        {
          messageId: "rename",
          data: { name: "formatter", source: "createIntl()", role: "intl", suffix: "Intl" },
        },
      ],
    },
    {
      code: `${pre}export function A() { const fmt = useFormat(); return fmt; }`,
      filename: "g.tsx",
      errors: [
        {
          messageId: "rename",
          data: { name: "fmt", source: "useFormat()", role: "format", suffix: "Format" },
        },
      ],
    },
    {
      code: `${pre}export function A() { const translate = useT(); return translate; }`,
      filename: "h.tsx",
      errors: [
        { messageId: "rename", data: { name: "translate", source: "useT()", role: "t", suffix: "T" } },
      ],
    },
    {
      code: `${pre}const intl = createIntl(config);\nexport const f = intl.format;`,
      filename: "i.ts",
      errors: [
        { messageId: "rename", data: { name: "f", source: "intl.format", role: "format", suffix: "Format" } },
      ],
    },
  ],
});
