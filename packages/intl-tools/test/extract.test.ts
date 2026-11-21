import { fixtures } from "#corpus";
import { IntlMessageFormat } from "intl-messageformat";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractMessages } from "../src/extract";

const PKG = "@elmeragroup/intl";

function keys(code: string, file = "x.tsx"): Array<string> {
  const outcome = extractMessages(file, code);

  if (outcome._tag === "Failed") {
    throw new Error(outcome.failures.map((f) => f.message).join("\n"));
  }

  return outcome.messages.map((m) => m.key);
}

function failure(code: string): string {
  const outcome = extractMessages("e.tsx", code);

  return outcome._tag === "Failed" ? outcome.failures.map((f) => f.message).join("\n") : "no error";
}

describe("fixtures", () => {
  // oxlint-disable-next-line tests/no-source-reading-tests -- the extractor's input is source text: reading the fixture file is the contract under test, cross-checked against the runtime keys in runtime.test.tsx.
  const source = readFileSync(new URL("../../intl/test/fixtures.tsx", import.meta.url), "utf8");
  const extracted = extractMessages("test/fixtures.tsx", source);

  // Unit under test: the extractor on compiled JSX. Oracle: the same hand-written keys the runtime must produce.
  it("extracts every fixture with its hand-written key", () => {
    expect(
      extracted._tag === "Extracted" ? extracted.messages.map((m) => m.key) : extracted.failures
    ).toEqual(fixtures.map((f) => f.key));
  });

  it("describes positional tags for translators", () => {
    const messages = extracted._tag === "Extracted" ? extracted.messages : [];
    expect(messages[7]?.tags).toEqual(["<x0> = <a href>", "<x1> = <Link href>"]);
    expect(messages[12]?.tags).toEqual(["<x0> = <br>"]);
  });

  it("extracts only sources that compile", () => {
    const messages = extracted._tag === "Extracted" ? extracted.messages : [];
    const broken = messages.filter((m) => {
      try {
        // oxlint-disable-next-line no-new -- constructing is the check: it throws on a source that does not compile
        new IntlMessageFormat(m.source, "en");

        return false;
      } catch {
        return true;
      }
    });
    expect(broken).toEqual([]);
  });
});

const pre = `import { T, Val, useT } from "${PKG}/react";\n`;
const pre2 = `import { T, Val, useT, createIntl } from "${PKG}/react";\nimport { getIntl, getT } from "${PKG}/server";\n`;
const preT = `import type { IntlInstance } from "${PKG}/core";\nimport { msg } from "${PKG}/react";\nconst D = msg("Desc");\n`;
const cfg = `{ locale: "en", catalog: {}, timeZone: "UTC" }`;

// Unit under test: the extraction contract table (README). Oracle: the keys or failure each form must produce,
// written out per case.
describe("scoped extraction", () => {
  it("extracts only bindings from this package, in non-React and server forms too", () => {
    expect(
      keys(`import { T, useT, msg, createIntl } from "${PKG}/react";
import { getT } from "${PKG}/server";
function A() { const t = useT(); return t(\`Template\`); }
function B() { const t = (s: string) => s; return t("not mine"); }
async function C() { const t = await getT(); return t("Server {n}", { n: 1 }); }
const intl = createIntl(${cfg}); intl.t("Script");
const S = { open: msg("Open", { context: "status" }) };
function E() { const t = useT(); return <T>Read <a title={t("Tooltip")}>terms</a></T>; }`)
    ).toEqual(["Template", "Server {n}", "Script", "status\u0004Open", "Read <x0>terms</x0>", "Tooltip"]);
  });

  it.each([
    [
      "alias of t",
      pre + `function A() { const t = useT(); const tr = t; return tr("Aliased"); }`,
      ["Aliased"],
    ],
    [
      "{ t } from getIntl",
      pre2 + `async function A() { const { t } = await getIntl(); return t("Destructured"); }`,
      ["Destructured"],
    ],
    ["{ t } from createIntl", pre2 + `const { t } = createIntl(${cfg}); t("Script2");`, ["Script2"]],
    [
      "{ t = fallback } from createIntl",
      pre2 + `const { t = undefined } = createIntl(${cfg}); t("Defaulted");`,
      ["Defaulted"],
    ],
    ["(await getIntl()).t(literal)", pre2 + `async function A() { return (await getIntl()).t("C"); }`, ["C"]],
    ["createIntl(cfg).t(literal)", pre2 + `createIntl(${cfg}).t("Inline");`, ["Inline"]],
    [
      "a bound getIntl() instance",
      pre2 + `async function A() { const i = await getIntl(); return i.t("GetIntl"); }`,
      ["GetIntl"],
    ],
    [
      "descriptor via t.from, extracted at msg()",
      pre2 +
        `import { msg } from "${PKG}/react";\nconst d = msg("F"); function A() { const t = useT(); return t.from(d); }`,
      ["F"],
    ],
    [
      "member alias of intl.t",
      pre2 + `const intl = createIntl(${cfg}); const tr = intl.t; tr("Hidden alias");`,
      ["Hidden alias"],
    ],
    [
      "closure using a t declared below",
      pre2 +
        `function A() { function helper() { return t("Hidden closure"); } const t = useT(); return helper(); }`,
      ["Hidden closure"],
    ],
    ["alias of createIntl(cfg).t", pre2 + `const tr = createIntl(${cfg}).t; tr("Hidden");`, ["Hidden"]],
    [
      "alias of (await getIntl()).t",
      pre2 + `async function A() { const tr = (await getIntl()).t; return tr("Hidden2"); }`,
      ["Hidden2"],
    ],
    [
      'string-literal "context" key',
      `import { msg } from "${PKG}/react";\nconst d = msg("M", { "context": "x" });`,
      ["x\u0004M"],
    ],
    [
      "[t] in a hook dependency array",
      `import { useT } from "${PKG}/react";\nimport { useMemo } from "react";\nfunction A() { const t = useT(); return useMemo(() => t("Memo"), [t]); }`,
      ["Memo"],
    ],
    [
      "useIntl() as an IntlInstance source",
      `import { useIntl } from "${PKG}/react";\nfunction A() { const intl = useIntl(); const { t } = intl; return t("From hook") + intl.t("Direct"); }`,
      ["From hook", "Direct"],
    ],
    [
      'intl["t"](literal), as intl.t',
      pre2 + `const i = createIntl(${cfg}); i["t"]("Computed");`,
      ["Computed"],
    ],
    [
      "review repro: a loop binding does not overwrite the outer t",
      pre + `function A() { const t = useT(); for (const t of [1]) {} return t("Hidden"); }`,
      ["Hidden"],
    ],
    [
      "var t hoisted out of a block",
      `import { getT } from "${PKG}/server";\nasync function f(c: boolean) { if (c) { var t = await getT(); } return t!("Lit"); }`,
      ["Lit"],
    ],
    [
      "residual: non-importing file destructuring t from an app wrapper is missed",
      `async function f() { const { t } = await getAppIntl(); return t("Lit"); }`,
      [],
    ],
  ] as const)("follows %s", (_label, code, expected) => {
    expect(keys(code)).toEqual(expected);
  });

  it.each([
    ["intl.locale read", pre2 + `const i = createIntl(${cfg}); const l = i.locale;`],
    [
      "(await getT()).from(d)",
      `import { getT } from "${PKG}/server";\nimport { msg } from "${PKG}/react";\nconst d = msg("D2"); async function f() { return (await getT()).from(d); }`,
    ],
    ["other libraries' t in a non-importing file", `const { t } = useTranslation(); t(key);`],
  ] as const)("allows %s", (_label, code) => {
    expect(failure(code)).toBe("no error");
  });
});

describe("deny by default", () => {
  it.each([
    ["namespace import", `import * as intl from "${PKG}/react"; intl.msg("x");`, "import * as"],
    ["re-export", `export { T } from "${PKG}/react";`, "re-exporting"],
    [
      "dynamic context",
      pre + `const c = "verb"; const x = <T context={c}>Open</T>;`,
      "`context` must be a string literal",
    ],
    [
      "t passed to a helper",
      pre + `function A() { const t = useT(); return helper(t); }`,
      "passed or stored",
    ],
    [
      "spread into <Val>",
      pre + `const p = { n: 1 }; const x = <T>Got <Val {...p} /></T>;`,
      "cannot be spread",
    ],
    // The advice binds the caller's own translator: a hook in a server action would break it.
    ["useT()(...)", pre2 + `function A() { return useT()("x"); }`, '`const t = useT(); t("…")`'],
    [
      "(await getT())(...)",
      pre2 + `async function A() { return (await getT())("x"); }`,
      '`const t = await getT(); t("…")`',
    ],
    ["wrapper hook around useT", pre2 + `export const useMyT = () => useT();`, "bind `useT()`"],
    [
      "t(stringConst)",
      pre2 + `function A() { const t = useT(); const label = "E"; return t(label); }`,
      "t() takes a string literal",
    ],
    [
      "t(map[key])",
      pre2 + `const L = { a: "A" } as const; function A(k: "a") { const t = useT(); return t(L[k]); }`,
      "t() takes a string literal",
    ],
    [
      "spread into <T>",
      pre2 + `const p = { children: "x" }; const x = <T {...p} />;`,
      "<T> props cannot be spread",
    ],
    [
      "non-literal <Plural> form",
      `import { T, Plural } from "${PKG}/react";\nconst v = "# things"; const x = <T>Got <Plural n={1} other={v} /></T>;`,
      "must be a string literal",
    ],
    [
      "<Select> without other",
      `import { T, Select } from "${PKG}/react";\nconst k = "a"; const x = <T>Got <Select k={k} _a="A" /></T>;`,
      "<Select> needs an `other` branch",
    ],
    [
      "non-literal <Select> branch",
      `import { T, Select } from "${PKG}/react";\nconst k = "a"; const v = "A"; const x = <T>Got <Select k={k} _a={v} other="O" /></T>;`,
      "<Select> branch `_a` must be a string literal",
    ],
    [
      "<Select> branch that is no ICU key",
      `import { T, Select } from "${PKG}/react";\nconst k = "a"; const x = <T>Got <Select k={k} _a-b="A" other="O" /></T>;`,
      "<Select> branch `_a-b`",
    ],
    [
      "<Select> branch spelling other",
      `import { T, Select } from "${PKG}/react";\nconst k = "a"; const x = <T>Got <Select k={k} _other="A" other="O" /></T>;`,
      "<Select> branch `_other`",
    ],
    [
      "<Select> with an unknown prop",
      `import { T, Select } from "${PKG}/react";\nconst k = "a"; const x = <T>Got <Select k={k} kind="b" other="O" /></T>;`,
      "<Select> needs exactly one value prop; name each case `_<key>`",
    ],
    [
      "<Select> called as a function",
      `import { T, Select } from "${PKG}/react";\nconst x = <T>Got {Select({ k: "a", other: "O" })}</T>;`,
      "use JSX",
    ],
    [
      "received IntlInstance: const { t } = intl",
      preT + `function a(intl: IntlInstance) { const { t } = intl; return t("A"); }`,
      "destructured from something",
    ],
    [
      "received IntlInstance: ({ t }: IntlInstance) param",
      preT + `function b({ t }: IntlInstance) { return t("B"); }`,
      "destructured in a parameter",
    ],
    [
      "received IntlInstance: const tr = intl.t",
      preT + `function c(intl: IntlInstance) { const tr = intl.t; return tr("D"); }`,
      "may only be called",
    ],
    [
      "bound IntlInstance: conditional message",
      pre2 + `const intl = createIntl(${cfg}); export const d = (c: boolean) => intl.t(c ? "J1" : "J2");`,
      "takes a string literal",
    ],
    [
      "bound IntlInstance: union-typed variable",
      pre2 + `const intl = createIntl(${cfg}); export const e = (label: "R1" | "R2") => intl.t(label);`,
      "takes a string literal",
    ],
    [
      "received IntlInstance: .t.bind",
      preT + `function f(i: IntlInstance) { return i.t.bind(i)("Q"); }`,
      "may only be called",
    ],
    [
      "received IntlInstance: const { t } = props.intl",
      preT + `function g(props: { intl: IntlInstance }) { const { t } = props.intl; return t("G"); }`,
      "destructured from something",
    ],
    ["export const useMyT = useT", pre2 + `export const useMyT = useT;`, "aliasing `useT`"],
    ["const MyT = T", pre2 + `const MyT = T;`, "aliasing `T`"],
    ["const m = msg", `import { msg } from "${PKG}/react";\nconst m = msg;`, "aliasing `msg`"],
    ["export const { t } = createIntl()", pre2 + `export const { t } = createIntl(${cfg});`, "exporting `t`"],
    ["export { t }", pre2 + `const { t } = createIntl(${cfg}); export { t };`, "exporting `t`"],
    [
      "msg(text, optsVar)",
      `import { msg } from "${PKG}/react";\nconst o = { context: "x" }; const d = msg("M", o);`,
      "object literal",
    ],
    [
      "msg options spread",
      `import { msg } from "${PKG}/react";\nconst opts = { context: "verb" }; const d = msg("Open", { ...opts });`,
      "without spreads",
    ],
    [
      "template with expressions",
      pre + `function A() { const t = useT(); return t(\`a\${1}\`); }`,
      "string literal",
    ],
    ["dynamic child in <T>", pre + `const n = 1; const x = <T>Got {n}</T>;`, "wrap values as <Val"],
    ["<T> inside <T>", pre + `const x = <T>Outer <T>Inner</T></T>;`, "<T> cannot contain another <T>"],
    ["syntax error", `const x = <T>Hi</`, "cannot parse"],
  ] as const)("rejects %s", (_label, code, expected) => {
    expect(failure(code)).toContain(expected);
  });

  // Every spelling of a t key, at any depth, in any binding form.
  it.each([
    [
      'intl["t"](u) on a param',
      `function f(intl: IntlInstance, u: "R1" | "R2") { return intl["t"](u); }`,
      "cannot trace `intl`",
    ],
    [
      'const { "t": tr } = intl',
      `function f(intl: IntlInstance) { const { "t": tr } = intl; return tr("Lit"); }`,
      "destructured from something",
    ],
    [
      'const { ["t"]: tr } = intl',
      `function f(intl: IntlInstance) { const { ["t"]: tr } = intl; return tr("Lit"); }`,
      "destructured from something",
    ],
    [
      "({ intl: { t } }: P) param",
      `function f({ intl: { t } }: { intl: IntlInstance }) { return t("Lit"); }`,
      "destructured in a parameter",
    ],
    [
      "const { intl: { t } } = props",
      `function f(props: { intl: IntlInstance }) { const { intl: { t } } = props; return t("Lit"); }`,
      "destructured from something",
    ],
    [
      "({ t: tr } = intl) assignment",
      `function f(intl: IntlInstance) { let tr: unknown; ({ t: tr } = intl); return tr; }`,
      "assigning `{ t }`",
    ],
    [
      "dynamic import of the package",
      `async function f() { const m = await import("${PKG}/server"); return m; }`,
      "dynamic import()",
    ],
    [
      "useT().call(null, label)",
      `import { useT } from "${PKG}/react";\nfunction f(label: string) { return useT().call(null, label as never); }`,
      "bind `useT()`",
    ],
    [
      "getT().then(...)",
      `import { getT } from "${PKG}/server";\nfunction f() { return getT().then((t) => t("X")); }`,
      "bind `getT()`",
    ],
    [
      "const [{ t }] = arr",
      `function f(arr: IntlInstance[]) { const [{ t }] = arr; return t("X"); }`,
      "destructured from an array",
    ],
    [
      "defaulted { t } param",
      `function f({ t }: IntlInstance = {} as IntlInstance) { return t("X"); }`,
      "destructured in a parameter",
    ],
    ["require(pkg)", `const m = require("${PKG}/react");`, "require() of the intl package"],
  ] as const)("rejects %s", (_label, code, expected) => {
    expect(failure(preT + code)).toContain(expected);
  });

  it("points a failure at the source line, not the compiled one", () => {
    const outcome = extractMessages(
      "p.tsx",
      `${pre}\n\nfunction A() {\n  const t = useT();\n  return helper(t);\n}\n`
    );
    const positions = outcome._tag === "Failed" ? outcome.failures.map((f) => f.position) : [];
    expect(positions).toEqual([{ line: 6, column: 16 }]);
  });
});

// Unit under test: the import-specifier scan. Oracle: the hand-written message an escaped specifier still imports.
describe("package specifiers", () => {
  it("resolves an import specifier written with an escape by its value", () => {
    expect(keys(`import { T } from "@elmeragroup/\\x69ntl/react";\nexport const x = <T>Hi</T>;`)).toEqual([
      "Hi",
    ]);
  });
});

function result(code: string): ReadonlyArray<string> {
  const extracted = extractMessages("r.tsx", code);

  return extracted._tag === "Extracted"
    ? extracted.messages.map((m) => m.key)
    : extracted.failures.map((f) => f.message);
}

const UNTRACED_INTL = (receiver: string) =>
  `cannot trace \`${receiver}\` to useIntl(), getIntl() or createIntl() in this file, so \`.t(…)\` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with \`.t.from\``;
const UNTRACED_T =
  "cannot trace `t` to useT() or getT() in this file, so `t(…)` is not extracted; bind `const t = useT()` (or `await getT()`) here";

// Unit under test: receiver provenance (R2-6). Oracle: the hand-written messages and diagnostics each receiver must produce:
// traced to the documented surface, extracted; unrelated (a non-intl package import or a value written in this file), ignored;
// anything else, a diagnostic naming the receiver.
describe("receiver provenance", () => {
  it.each([
    [
      "Sol 1: fake.t on a local object literal is not a message",
      `const fake = { t: (s: string) => s }; export const x = fake.t("Fake");`,
      [],
    ],
    [
      "Sol 1, importing file",
      `import { msg } from "${PKG}/react";\nconst fake = { t: (s: string) => s }; export const x = [msg("M"), fake.t("Fake")];`,
      ["M"],
    ],
    [
      "Sol 2: unrelated { t } from another library in a msg file",
      `import { msg } from "${PKG}/react";\nimport { useTranslation } from "react-i18next";\nconst d = msg("D"); export function A() { const { t } = useTranslation(); return [d, t("k")]; }`,
      ["D"],
    ],
    [
      ".t on a non-intl package import",
      `import { msg } from "${PKG}/react";\nimport i18next from "i18next";\nexport const x = [msg("M"), i18next.t("k"), i18next.t(String(1))];`,
      ["M"],
    ],
    [
      "const tr = <non-intl package value>.t",
      `import { msg } from "${PKG}/react";\nimport i18next from "i18next";\nconst tr = i18next.t; export const x = [msg("M"), tr];`,
      ["M"],
    ],
    [
      "bare t declared as a local function",
      `import { msg } from "${PKG}/react";\nfunction t(s: string) { return s; }\nexport const x = [msg("M"), t("local")];`,
      ["M"],
    ],
    [
      ".t.from on a received IntlInstance (the descriptor is extracted at msg())",
      preT + `export function ok(intl: IntlInstance) { return intl.t.from(D); }`,
      ["Desc"],
    ],
  ] as const)("ignores %s", (_label, code, expected) => {
    expect(result(code)).toEqual(expected);
  });

  it.each([
    ["a parameter", `export function f(intl: { t(s: string): string }) { return intl.t("P"); }`, "intl"],
    [
      "a parameter's property",
      `export function f(ctx: { intl: { t(s: string): string } }) { return ctx.intl.t("P"); }`,
      "ctx.intl",
    ],
    ["a relative import", `import { intl } from "./intl";\nexport const x = intl.t("P");`, "intl"],
    [
      "a workspace import",
      `import { intl } from "@elmeragroup/api/intl";\nexport const x = intl.t("P");`,
      "intl",
    ],
    [
      "a local function's result",
      `function make() { return { t: (s: string) => s }; }\nexport const x = make().t("P");`,
      "make()",
    ],
    [
      "an object literal holding a parameter",
      `export function f(i: { t(s: string): string }) { const box = { a: i }; return box.a.t("P"); }`,
      "box.a",
    ],
    [
      "an object literal with a getter",
      `export function f() { const box = { get t() { return (s: string) => s; } }; return box.t("P"); }`,
      "box",
    ],
    [
      "a computed const key on a parameter",
      `export function f(i: { t(s: string): string }) { const k = "t"; return i[k]("P"); }`,
      "i",
    ],
  ] as const)("reports a .t call on %s, importing or not", (_label, code, receiver) => {
    expect(result(code)).toEqual([UNTRACED_INTL(receiver)]);
    expect(result(preT + code)).toEqual([UNTRACED_INTL(receiver)]);
  });

  it.each([
    [
      "an npm hook's result built by a callback",
      `import { useMemo } from "react";\nexport function A() { const i = useMemo(() => createIntl(${cfg}), []); return i.t("M"); }`,
      "i",
    ],
    [
      "an npm hook's result read from an app module's value",
      `import { useContext } from "react";\nimport { Ctx } from "./ctx";\nexport function A() { const i = useContext(Ctx); return i.t("M"); }`,
      "i",
    ],
    [
      "a reassigned variable",
      `let i: { t(s: string): string } | null = null; i = createIntl(${cfg}); export const x = i.t("M");`,
      "i",
    ],
    [
      "a member written into a local object",
      `const box: { i?: { t(s: string): string } } = {}; box.i = createIntl(${cfg}); export const x = box.i.t("M");`,
      "box.i",
    ],
    [
      "an npm hook's result built by a named callback",
      `import { useMemo } from "react";\nconst make = () => createIntl(${cfg});\nexport function A() { const intl = useMemo(make, []); return intl.t("Hello {name}", { name: "Ada" }); }`,
      "intl",
    ],
    [
      "a destructured default",
      `const { intl = createIntl(${cfg}) } = {}; export const x = intl.t("M");`,
      "intl",
    ],
    [
      "a projection out of a local container",
      `const box = {}; box.intl = createIntl(${cfg}); const { intl } = box; export const x = intl.t("M");`,
      "intl",
    ],
    [
      "an npm hook's state set elsewhere",
      `import { useState } from "react";\nexport function A() { const [i, setI] = useState(null); setI(createIntl(${cfg})); return i.t("M"); }`,
      "i",
    ],
    [
      "an npm hook's ref written elsewhere",
      `import { useRef } from "react";\nexport function A() { const r = useRef(null); r.current = createIntl(${cfg}); return r.current.t("M"); }`,
      "r.current",
    ],
  ] as const)("reports a .t call on %s", (_label, code, receiver) => {
    expect(result(pre2 + code)).toEqual([UNTRACED_INTL(receiver)]);
  });

  it("reports a bare t that is not bound from useT() or getT() in an importing file", () => {
    expect(result(`${pre}export function D(t: (s: string) => string) { return t("Param"); }`)).toEqual([
      UNTRACED_T,
    ]);
  });
});
