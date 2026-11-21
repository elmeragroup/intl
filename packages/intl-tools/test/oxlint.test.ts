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
const UNTRACED_I =
  "cannot trace `i` to useIntl(), getIntl() or createIntl() in this file, so `.t(…)` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with `.t.from`";

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
    ],
    invalid: [
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
              "cannot trace `intl` to useIntl(), getIntl() or createIntl() in this file, so `.t(…)` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with `.t.from`",
            line: 2,
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
