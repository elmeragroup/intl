import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "../src/oxlint";

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules.extractable;

if (!rule) {
  throw new Error("the elmera-intl plugin has no extractable rule");
}

const pre = `import { T, Val, useT } from "@elmeragroup/intl/react";\n`;
const preEffect = `import * as Effect from "effect/Effect";\nimport { CurrentIntl } from "@elmeragroup/intl/effect";\n`;
const UNTRACED_I =
  "cannot trace `i` to useIntl(), getIntl(), createIntl() or `yield* CurrentIntl` in this file, so `.t(…)` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with `.t.from`";

// Unit under test: the elmera-intl/extractable rule. Oracle: the extraction contract per case, with the failure's message
// and its position in the source as written (the rule maps compiled positions back).
new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "tsx" } } }).run(
  "extractable",
  rule,
  {
    valid: [
      {
        code: `${pre}export function A() { const t = useT(); return <p title={t("Title")}><T>Hi <Val name="x" /></T></p>; }`,
        filename: "a.tsx",
      },
      // Not the package: another library's t is none of this rule's business.
      { code: `const { t } = useTranslation(); t(key);`, filename: "b.tsx" },
      { code: `export const docs = "see @elmeragroup/intl";`, filename: "c.ts" },
      // A .t on a value written in this file or a non-intl package import is not a translation.
      {
        code: `import i18next from "i18next";\nconst fake = { t: (s: string) => s };\nexport const x = [fake.t("a"), i18next.t("b")];`,
        filename: "g.ts",
      },
      // Another library's translator, rooted in an npm import, in a file that does not import the package.
      {
        code: `import { useTranslation } from "react-i18next";\nexport function A() { const { t } = useTranslation(); return t("k"); }`,
        filename: "i18next.tsx",
      },
      // The Effect service read as the contract allows: `yield* CurrentIntl`, destructured.
      {
        code: `${preEffect}export const f = Effect.gen(function* () { const { t } = yield* CurrentIntl; return t("Hello"); });`,
        filename: "effect.ts",
      },
      // An IntlInstance's own members may be passed on (#40).
      {
        code: `import { useIntl } from "@elmeragroup/intl/react";\nimport { due } from "./due";\nexport function Page() { const intl = useIntl(); return <p>{due(intl.format, intl.locale)}</p>; }`,
        filename: "members.tsx",
      },
    ],
    invalid: [
      // An IntlInstance passed on fails in the file that binds it (#40): the file that receives it cannot tell.
      {
        code: `import { useIntl } from "@elmeragroup/intl/react";\nimport { Row } from "./row";\nexport function Page() { const intl = useIntl(); return <Row intl={intl} />; }`,
        filename: "page.tsx",
        errors: [
          {
            message:
              "`intl` is an IntlInstance (or a promise of one) used as a value, not through its own members, so wherever it goes its `t` is not extracted; bind one where it is used (`useT()` or `useIntl()` in the child, `await getIntl()`, `yield* CurrentIntl` provided by `CurrentIntl.layer(options)` or `CurrentIntl.provide(effect)`, or `createIntl(config)` with the config passed), or pass `msg()` descriptors, its `format` or its `locale`",
            line: 3,
            // oxlint columns are 0-based: `intl` in `intl={intl}`.
            column: 67,
          },
        ],
      },
      // Any other read of the service, at its position in the source.
      {
        code: `${preEffect}export const f = CurrentIntl.use((intl) => Effect.succeed(intl.locale));\n`,
        filename: "effect-use.ts",
        errors: [
          {
            message:
              "`CurrentIntl` is only read with `yield* CurrentIntl` and provided with `.layer(…)` or `.provide(…)`, so extraction sees every translator; read the translator with `const { t } = yield* CurrentIntl`",
            line: 3,
            // oxlint columns are 0-based: `CurrentIntl` after "export const f = ".
            column: 17,
          },
        ],
      },
      // Lint and extraction agree on every file: no text filter may skip a file extraction rejects.
      ...[`return i./* c */t("X");`, `return i.// c\n    t("X");`, `return i["\\u0074"]("X");`].map(
        (body, index) => ({
          code: `export function f(i: { t(s: string): string }) {\n  ${body}\n}\n`,
          filename: `u${index}.ts`,
          errors: [{ message: UNTRACED_I, line: 2, column: 9 }],
        })
      ),
      // A file that never names the package still runs the rule: an IntlInstance may arrive as a parameter.
      {
        code: `export function f(intl: { t(s: string): string }) {\n  return intl.t("P");\n}\n`,
        filename: "h.ts",
        errors: [
          {
            message:
              "cannot trace `intl` to useIntl(), getIntl(), createIntl() or `yield* CurrentIntl` in this file, so `.t(…)` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with `.t.from`",
            line: 2,
            column: 9,
          },
        ],
      },
      // A file that never names the package still runs the rule: a translator may come from an app module (#30).
      {
        code: `import { translator } from "../shared/wrap";\nexport async function Page() {\n  const t = await translator();\n  return t("Hello through a wrapper");\n}\n`,
        filename: "page.tsx",
        errors: [
          {
            message:
              "cannot trace `t` to useT() or getT(), or to the `.t` of an IntlInstance from useIntl(), getIntl(), createIntl() or `yield* CurrentIntl`, in this file; it comes from `../shared/wrap`, so `t(…)` is not extracted; bind it here (`const t = useT()`, `const t = await getT()`, or an instance's `const { t } = await getIntl()`), or translate `msg()` descriptors with `t.from(descriptor)` / `.t.from`. If this `t` is another library's translator (an app module wrapping it while the app migrates), rename it in this file, or, if this file's only i18n is this legacy translator, list this file in `exclude` and turn `elmera-intl/extractable` off for it (see the README's migration section)",
            line: 4,
            column: 9,
          },
        ],
      },
      {
        code: `${pre}export function A(label: string) {\n  const t = useT();\n  return t(label);\n}\n`,
        filename: "d.tsx",
        errors: [
          {
            message: "t() takes a string literal; for a msg() descriptor use t.from(descriptor)",
            line: 4,
            // oxlint's RuleTester columns are 0-based: `t` in "  return t(label);".
            column: 9,
          },
        ],
      },
      {
        code: `import { T, Select } from "@elmeragroup/intl/react";\nconst k = "a";\nexport const x = <T>Got <Select k={k} _a="A" /></T>;\n`,
        filename: "s.tsx",
        errors: [
          // oxlint columns are 0-based: `<` of `<Select`.
          { message: '<Select> needs an `other` branch: ICU requires it (`other="…"`)', line: 3, column: 24 },
        ],
      },
      {
        code: `${pre}const n = 1;\nexport const x = <T>Got {n}</T>;\n`,
        filename: "e.tsx",
        errors: [{ message: "dynamic child in <T>; wrap values as <Val name={value} />" }],
      },
      {
        code: `${pre}export const useMyT = () => useT();\n`,
        filename: "f.tsx",
        errors: [
          {
            message:
              "bind `useT()` to a variable where it is called (wrapping it hides messages from extraction)",
            line: 2,
          },
        ],
      },
    ],
  }
);
