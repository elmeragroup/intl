import type { ReactElement } from "react";
import { isValidElement } from "react";

import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";
import { hashKey } from "@elmeragroup/intl/internal/message";
import { IntlProvider } from "@elmeragroup/intl/react";

import { compileCatalog } from "../src/compile";
import { extractMessages } from "../src/extract";

// Each row is one module. The same text is extracted and, written to disk, imported and rendered, so the extracted
// key and the key the runtime looks up come from one source and cannot be hand-copied apart.
const HEADER = `import { Plural, Select, T, Val, msg, useT, useIntl, createIntl } from "@elmeragroup/intl/react";\n`;

/** What the runtime does with a `<T>` the extractor rejects. */
type RuntimeEnding =
  // onError receives this, and the children render untranslated, looking up exactly these keys (none when absent: a
  // walk problem returns before any lookup; an inner <T> translating itself looks up its own).
  | { readonly reports: string; readonly looksUp?: Lookups }
  // The runtime reads what React built, which the extractor's static refusal cannot see, and looks these keys up.
  | { readonly looksUp: Lookups; readonly reports?: never };

/** The keys a render looks up, written out: at least one. */
type Lookups = readonly [string, ...Array<string>];

// One kind per row: each names its own field and rules out the others', so no field is silently ignored.
type Row = { readonly label: string; readonly code: string } & (
  | {
      readonly keys: ReadonlyArray<string>;
      // A value the extractor cannot see: it extracts the key, and the runtime reports it and renders the children.
      readonly runtime?: Extract<RuntimeEnding, { readonly reports: string }>;
      readonly fails?: never;
      readonly rejects?: never;
      readonly misses?: never;
    }
  | {
      readonly fails: string;
      readonly runtime?: never;
      readonly keys?: never;
      readonly rejects?: never;
      readonly misses?: never;
    }
  // A <T> grammar rule: both halves, the extractor's failure and the runtime's ending for the same text.
  | {
      readonly rejects: string;
      readonly runtime: RuntimeEnding;
      readonly keys?: never;
      readonly fails?: never;
      readonly misses?: never;
    }
  // A documented residual: the extractor finds nothing and the runtime looks these keys up.
  | {
      readonly misses: ReadonlyArray<string>;
      readonly runtime?: never;
      readonly keys?: never;
      readonly fails?: never;
      readonly rejects?: never;
    }
);

const rows: ReadonlyArray<Row> = [
  { label: "plain text", code: `export const el = <T>Hello</T>;`, keys: ["Hello"] },
  {
    label: "named Fragment from react",
    code: `import { Fragment } from "react";\nexport const el = <T>Hello <Fragment>there</Fragment></T>;`,
    keys: ["Hello there"],
  },
  {
    label: "aliased Fragment from react",
    code: `import { Fragment as F } from "react";\nexport const el = <T>Hello <F>there</F></T>;`,
    keys: ["Hello there"],
  },
  {
    label: "keyed React.Fragment via a namespace import",
    code: `import * as React from "react";\nexport const el = <T>Hello <React.Fragment key="k">there</React.Fragment></T>;`,
    keys: ["Hello there"],
  },
  {
    label: "React.Fragment via a default import",
    code: `import React from "react";\nexport const el = <T>Hello <React.Fragment>there</React.Fragment></T>;`,
    keys: ["Hello there"],
  },
  {
    label: "explicit children attribute alone (same props object either way)",
    code: `export const el = <T>Read <a children="terms" /></T>;`,
    keys: ["Read <x0>terms</x0>"],
  },
  {
    // oxc inlines a literal spread into plain props, so both sides read the same children.
    label: "an inlined object-literal spread",
    code: `export const el = <T>Read <b {...{ children: "Changed" }} /></T>;`,
    keys: ["Read <x0>Changed</x0>"],
  },
  {
    label: "the same <Val> value twice",
    code: `const n = "1";\nexport const el = <T><Val n={n} /> of <Val n={n} /></T>;`,
    keys: ["{n} of {n}"],
  },
  {
    label: "const-resolved computed context key in msg()",
    code: `const k = "context";\nconst d = msg("Open", { [k]: "verb" });\nfunction C() { const t = useT(); return t.from(d); }\nexport const el = <C />;`,
    keys: ["verb\u0004Open"],
  },
  {
    label: "unresolved computed context key in msg()",
    code: `function make(k: string) { return msg("Open", { [k]: "verb" }); }\nfunction C() { const t = useT(); return t.from(make("context")); }\nexport const el = <C />;`,
    fails: "computed key",
  },
  {
    label: "string-literal computed context key in msg()",
    code: `const d = msg("Open", { ["context"]: "verb" });\nfunction C() { const t = useT(); return t.from(d); }\nexport const el = <C />;`,
    keys: ["verb\u0004Open"],
  },
  {
    label: "const-resolved computed t key destructured from an IntlInstance",
    code: `const k = "t";\nfunction C() { const intl = useIntl(); const { [k]: tr } = intl; return <>{tr("Hidden")}</>; }\nexport const el = <C />;`,
    keys: ["Hidden"],
  },
  {
    label: "unresolved computed t key destructured from an IntlInstance",
    code: `function C({ k }: { k: string }) { const intl = useIntl(); const { [k]: tr } = intl; return <>{tr("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key",
  },
  {
    label: "spread on a nested element",
    code: `const props = { children: "Hidden" };\nexport const el = <T>Read <a {...props} /></T>;`,
    rejects: "spread",
    runtime: { looksUp: ["Read <x0>Hidden</x0>"] },
  },
  {
    label: "explicit children attribute overridden by JSX children",
    code: `export const el = <T>Read <a children="X">Y</a></T>;`,
    rejects: "`children`",
    runtime: { looksUp: ["Read <x0>Y</x0>"] },
  },
  {
    label: "<Val> named like a positional tag",
    code: `export const el = <T><Val x0="Ada" /> read <a>terms</a></T>;`,
    rejects: "argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it",
    runtime: { reports: "argument name `x0` is reserved for positional tags (x0, x1, …) in <T>; rename it" },
  },
  {
    label: "<Select> named like a positional tag",
    code: `export const el = <T><Select x0="a" _a="A" other="O" /> in <b>cart</b></T>;`,
    rejects: "reserved",
    runtime: { reports: "reserved" },
  },
  {
    label: "<Plural> named like a positional tag",
    code: `export const el = <T><Plural x0={2} one="# item" other="# items" /> in <b>cart</b></T>;`,
    rejects: "reserved",
    runtime: { reports: "reserved" },
  },
  {
    label: "<Select> without other",
    code: `export const el = <T>Got <Select k="a" _a="A" /></T>;`,
    rejects: "needs an `other` branch",
    runtime: { reports: "<Select> needs an `other` branch" },
  },
  {
    label: "<Select> branch that is not text",
    code: `export const el = <T>Got <Select k="a" _a={1} other="O" /></T>;`,
    rejects: "branch `_a` must be a string literal",
    runtime: { reports: "<Select _a> needs a string literal branch" },
  },
  {
    label: "<Select> branch that is no select key",
    code: `export const el = <T>Got <Select k="a" _a-b="A" other="O" /></T>;`,
    rejects: "is no select key",
    runtime: { reports: "is no select key" },
  },
  {
    label: "<Select> branch spelling other",
    code: `export const el = <T>Got <Select k="a" _other="A" other="O" /></T>;`,
    rejects: "duplicates `other`",
    runtime: { reports: "duplicates `other`" },
  },
  {
    label: "<Select> with a second value prop",
    code: `export const el = <T>Got <Select k="a" kind="b" other="O" /></T>;`,
    rejects: "needs exactly one value prop",
    runtime: { reports: "needs exactly one value prop, got k, kind" },
  },
  {
    label: "<Plural> form that is not text",
    code: `export const el = <T>Got <Plural n={1} one={1} other="#" /></T>;`,
    rejects: "form `one` must be a string literal",
    runtime: { reports: "<Plural one> needs a string literal form" },
  },
  {
    label: "<Val> with two value props",
    code: `export const el = <T>Got <Val a="1" b="2" /></T>;`,
    rejects: "needs exactly one value prop",
    runtime: { reports: "needs exactly one value prop, got a, b" },
  },
  {
    label: "<Select> without a value prop",
    code: `export const el = <T>Got <Select _a="A" other="O" /></T>;`,
    rejects: "needs exactly one value prop",
    runtime: { reports: "needs exactly one value prop, got none" },
  },
  {
    // Numbered in pre-order: the outer tag first.
    label: "a tag inside a tag",
    code: `export const el = <T><b><i>x</i></b></T>;`,
    keys: ["<x0><x1>x</x1></x0>"],
  },
  {
    // An untyped value (`await res.json()`) passes ValProps; only the runtime sees it is neither text nor a number,
    // reports it under the extracted key, and renders the children (#99).
    label: "a <Val> value that is neither text nor a number",
    code: `const o: any = JSON.parse('{"a":1}');\nexport const el = <T>x <Val v={o} /></T>;`,
    keys: ["x {v}"],
    runtime: { reports: "<Val v> needs a string or number value" },
  },

  {
    // Literal-only: a const is text to the runtime.
    label: "<Select> branch from a const",
    code: `const v = "A";\nexport const el = <T>Got <Select k="a" _a={v} other="O" /></T>;`,
    rejects: "branch `_a` must be a string literal",
    runtime: { looksUp: ["Got {k, select, a {A} other {O}}"] },
  },
  {
    label: "<T> inside <T>",
    code: `export const el = <T>a <T>b</T></T>;`,
    rejects: "<T> cannot contain another <T>",
    // The outer message is never looked up; the inner <T>, rendered as written, translates itself.
    runtime: { reports: "<T> cannot contain another <T>", looksUp: ["b"] },
  },
  {
    label: "<T> inside a tag inside <T>",
    code: `export const el = <T>a <b><T>c</T></b></T>;`,
    rejects: "<T> cannot contain another <T>",
    // The outer message is never looked up; the inner <T>, rendered as written, translates itself.
    runtime: { reports: "<T> cannot contain another <T>", looksUp: ["c"] },
  },
  {
    label: "a branch name on <Val> is its value",
    code: `const n = "1";\nexport const el = <T>Got <Val one={n} /></T>;`,
    keys: ["Got {one}"],
  },

  {
    label: "one <Val> name with two values",
    code: `const a = 1;\nconst b = 2;\nexport const el = <T><Val n={a} /> of <Val n={b} /></T>;`,
    rejects: "two values",
    runtime: { reports: "two values" },
  },
  {
    label: "<T> called as a function",
    code: `function C() { return T({ children: "Hello" }); }\nexport const el = <C />;`,
    fails: "use JSX",
  },
  {
    label: "<Val> called as a function",
    code: `export const el = <T>Hi {Val({ n: 1 })}</T>;`,
    fails: "use JSX",
  },
  // Binding resolution (scopes): a name means the declaration JavaScript resolves it to.
  {
    label: "t used after a loop head that shadows it",
    code: `function C() { const t = useT(); for (const t of [1]) { void t; } return <>{t("Hidden")}</>; }\nexport const el = <C />;`,
    keys: ["Hidden"],
  },
  {
    label: "t used after a block, catch, class and switch that shadow it",
    code: `function C() {\n  const t = useT();\n  { const t = 1; void t; }\n  try { void 0; } catch (t) { void t; }\n  void class t {};\n  switch (1) { case 1: { const t = 2; void t; } }\n  return <>{t("Hidden")}</>;\n}\nexport const el = <C />;`,
    keys: ["Hidden"],
  },
  {
    label: "a translator shadowed by a parameter is not a translator",
    code: `function C() { const t = useT(); const f = (t: (s: string) => string) => t("Param"); return <>{t("Outer")}{f((s) => s)}</>; }\nexport const el = <C />;`,
    fails: "cannot trace `t` to useT() or getT(), or to the `.t` of an IntlInstance",
  },
  {
    label: "var t hoisted out of a nested block",
    code: `function C() { { var t = useT(); } return <>{t("Hoisted")}</>; }\nexport const el = <C />;`,
    keys: ["Hoisted"],
  },
  {
    label: "a closure using a t declared below it",
    code: `function C() { const show = () => t("Closure"); const t = useT(); return <>{show()}</>; }\nexport const el = <C />;`,
    keys: ["Closure"],
  },
  {
    label: "a parameter named T is an ordinary component",
    code: `function Box({ T }: { T: (p: { children: string }) => string }) { return <T>Not a message</T>; }\nexport const el = <><Box T={({ children }) => children} /><T>Real</T></>;`,
    keys: ["Real"],
  },
  {
    label: "a parameter named msg is not the package's msg",
    code: `function label(msg: (s: string) => string, v: string) { return msg(v); }\nexport const el = <><T>Plain</T>{label((s) => s, "x")}</>;`,
    keys: ["Plain"],
  },
  {
    label: "a local Fragment shadowing react's is an element",
    code: `import { Fragment } from "react";\nfunction C() { const Fragment = "b"; return <T>Hi <Fragment>there</Fragment></T>; }\nexport const el = <><C /><T>Hi <Fragment>all</Fragment></T></>;`,
    keys: ["Hi <x0>there</x0>", "Hi all"],
  },
  // Each expression resolves in the environment it is evaluated in, not the scope of the node it hangs off.
  {
    label: "a switch discriminant resolves outside the case block",
    code: `function C() { const i = useIntl(); const tr = i.t; let out = "";\n  switch (tr("Switch")) { default: const tr = () => ""; out = tr(); }\n  return <>{out}</>;\n}\nexport const el = <C />;`,
    keys: ["Switch"],
  },
  {
    label: "a parameter default does not see the body's var",
    code: `function C() { const t = useT(); function f(x = t("Param default")) { var t = () => "local"; void t; return x; } return <>{f()}</>; }\nexport const el = <C />;`,
    keys: ["Param default"],
  },
  {
    label: "an arrow parameter default does not see the body's var",
    code: `function C() { const t = useT(); const f = (x = t("Arrow default")) => { var t = () => "local"; void t; return x; }; return <>{f()}</>; }\nexport const el = <C />;`,
    keys: ["Arrow default"],
  },
  {
    label: "a static block's var stays in the block",
    code: `function C() { const t = useT(); function inner() { class A { static { var t = 0; void t; } } void A; return t("Static block"); } return <>{inner()}</>; }\nexport const el = <C />;`,
    keys: ["Static block"],
  },
  {
    label: "a for head resolves outside the loop body",
    code: `function C() { const t = useT(); let done = false;\n  for (let x = t("For head"); !done; done = true) { const t = 0; void t; void x; }\n  for (const x of [t("For-of right")]) { const t = 0; void t; void x; }\n  return <></>;\n}\nexport const el = <C />;`,
    keys: ["For head", "For-of right"],
  },
  {
    label: "class heritage and computed keys resolve outside the class body",
    code: `function C() { const t = useT(); class A extends (t("Heritage"), Object) { [t("Computed key")] = 1; static t = 0; } void A; return <></>; }\nexport const el = <C />;`,
    keys: ["Heritage", "Computed key"],
  },
  {
    label: "a catch parameter default resolves outside the catch body",
    code: `function C() { const t = useT(); let out = "";\n  try { throw {}; } catch ({ a = t("Catch default") }) { const t = 0; void t; out = a; }\n  return <>{out}</>;\n}\nexport const el = <C />;`,
    keys: ["Catch default"],
  },
  {
    label: "a named function expression's name shadows only inside it",
    code: `function C() { const t = useT(); const g = function t(n: number): string { return n ? "" : t(1); }; return <>{g(0)}{t("Named fn outer")}</>; }\nexport const el = <C />;`,
    keys: ["Named fn outer"],
  },
  // Property reads: every syntax that can read `t` off an IntlInstance.
  {
    label: "member i.t(literal)",
    code: `function C() { const i = useIntl(); return <>{i.t("Member")}</>; }\nexport const el = <C />;`,
    keys: ["Member"],
  },
  {
    label: "optional member i?.t(literal)",
    code: `function C() { const i = useIntl(); return <>{i?.t("Optional")}</>; }\nexport const el = <C />;`,
    keys: ["Optional"],
  },
  {
    label: "optional call i.t?.(literal) and t?.(literal)",
    code: `function C() { const i = useIntl(); const t = useT(); return <>{i.t?.("Optional call")}{t?.("Optional t")}</>; }\nexport const el = <C />;`,
    keys: ["Optional call", "Optional t"],
  },
  {
    label: "parenthesized callee (i.t)(literal)",
    code: `function C() { const i = useIntl(); return <>{(i.t)("Parens")}</>; }\nexport const el = <C />;`,
    keys: ["Parens"],
  },
  {
    label: 'computed string key i["t"](literal)',
    code: `function C() { const i = useIntl(); return <>{i["t"]("String key")}</>; }\nexport const el = <C />;`,
    keys: ["String key"],
  },
  {
    label: "computed template key i[`t`](literal)",
    code: 'function C() { const i = useIntl(); return <>{i[`t`]("Template key")}{i?.[`t`]("Optional template key")}</>; }\nexport const el = <C />;',
    keys: ["Template key", "Optional template key"],
  },
  {
    label: "computed const key i[k](literal)",
    code: `const k = "t";\nconst alias = k;\nfunction C() { const i = useIntl(); return <>{i[alias]("Const key")}</>; }\nexport const el = <C />;`,
    keys: ["Const key"],
  },
  {
    label: 'computed t["from"](descriptor)',
    code: `const d = msg("From computed");\nfunction C() { const t = useT(); return <>{t["from"](d)}</>; }\nexport const el = <C />;`,
    keys: ["From computed"],
  },
  // On a receiver the extractor infers to be an IntlInstance, an unresolved computed key may read `t`: the read fails.
  {
    label: "unresolved computed key on an IntlInstance, called",
    code: `function C({ k }: { k: string }) { const i = useIntl(); return <>{i[k as "t"]("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key on an IntlInstance",
  },
  {
    label: "unresolved computed key on an IntlInstance, optional-called",
    code: `function C({ k }: { k: string }) { const i = useIntl(); return <>{i[k as "t"]?.("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key on an IntlInstance",
  },
  {
    label: "unresolved computed key on an IntlInstance alias, aliased then called",
    code: `function C({ k }: { k: string }) { const i = useIntl(); const j = i; const f = j[k as "t"]; return <>{f("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key on an IntlInstance",
  },
  {
    label: "unresolved computed key on a created IntlInstance, stored on an object and called",
    code: `function C({ k }: { k: string }) { const callbacks: Record<string, (s: string) => string> = {}; callbacks[k] = createIntl({ locale: "nb", catalog: {}, timeZone: "UTC" })[k as "t"]; return <>{callbacks[k]("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key on an IntlInstance",
  },
  {
    label: "unresolved computed key on an IntlInstance, as a pattern default",
    code: `function C({ k }: { k: string }) { const i = useIntl(); const { g = i[k as "t"] }: { g?: (s: string) => string } = {}; return <>{g("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "computed key on an IntlInstance",
  },
  {
    label: "Reflect aliased by destructuring",
    code: `function C() { const i = useIntl(); const { get } = Reflect; return <>{(get(i, "t") as (s: string) => string)("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "`Reflect` is passed or stored",
  },
  {
    label: "a call inside a declaration pattern's default",
    code: `function C({ p }: { p: { a?: string } }) { const t = useT(); const { a = t("Pattern default") } = p; return <>{a}</>; }\nexport const el = <C p={{}} />;`,
    keys: ["Pattern default"],
  },
  {
    label: "t stored as a pattern default",
    code: `function C() { const t = useT(); const { a = t }: { a?: (s: string) => string } = {}; return <>{a("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "passed or stored",
  },
  // A receiver of unknown kind is not followed (README): type annotations are erased before extraction, so a parameter
  // typed IntlInstance is unknown too, and its unresolved computed read is missed. The instance fails where it is handed
  // on instead (#40), so the key the runtime looks up is never silently left out.
  {
    label: "an IntlInstance passed to a helper that reads it by an unresolved key",
    code: `import type { IntlInstance } from "@elmeragroup/intl/core";\nfunction show(i: IntlInstance, k: string) { return i[k as "t"]("Hidden"); }\nfunction C() { return <>{show(useIntl(), "t")}</>; }\nexport const el = <C />;`,
    fails: "`useIntl()` is an IntlInstance (or a promise of one) used as a value",
  },
  {
    label: "an IntlInstance stored in a container and read by an unresolved key",
    code: `function C({ k }: { k: string }) { const box = { i: useIntl() }; const f = box.i[k as "t"]; return <>{f("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "`useIntl()` is an IntlInstance (or a promise of one) used as a value",
  },
  {
    label: "unresolved computed key, read as a value (an app's label map)",
    code: `const LABELS = { open: msg("Open") };\nfunction C({ k }: { k: "open" }) { const t = useT(); const labels: Record<string, string> = { open: "o" }; return <>{t.from(LABELS[k])}{labels[k]?.trim()}</>; }\nexport const el = <C k="open" />;`,
    keys: ["Open"],
  },
  {
    label: "unresolved computed key, called on a const object literal (a catalog loader map)",
    code: `const LOADERS = { open: () => "o" };\nfunction C({ k }: { k: "open" }) { return <T>Loaded <Val v={LOADERS[k]()} /></T>; }\nexport const el = <C k="open" />;`,
    keys: ["Loaded {v}"],
  },
  {
    label: "unresolved computed reads stored, destructured and called on app records",
    code: `const BRANDS: Record<string, { logo: string }> = { a: { logo: "L" } };\nfunction C({ k, fns }: { k: string; fns: Record<string, () => string> }) { const criteria: Record<string, string> = {}; criteria[k] = fns[k]?.() ?? ""; const { logo } = BRANDS[k] ?? { logo: "" }; const [first] = [fns[k]]; return <><T>Shown</T>{criteria[k]}{logo}{first?.()}</>; }\nexport const el = <C k="a" fns={{ a: () => "x" }} />;`,
    keys: ["Shown"],
  },
  {
    label: "unresolved computed reads in returned literals (a label map from a hook)",
    code: `function C({ labels }: { labels: Record<string, string> }) { const row = (p: string) => { return { value: p, label: labels[p] }; }; const items = ["a"].map((p) => ({ value: p, label: labels[p] })); return <><T>Shown</T>{items.map((x) => x.label)}{row("a").label}</>; }\nexport const el = <C labels={{ a: "A" }} />;`,
    keys: ["Shown"],
  },
  {
    label: "unresolved computed reads in a translator's values",
    code: `function C({ labels, k }: { labels: Record<string, string>; k: string }) { const t = useT(); const i = useIntl(); return <>{t("Of {a}", { a: labels[k] ?? "" })}{i.t("On {a}", { a: labels[k] ?? "" })}{t.from(msg("From {a}"), { a: labels[k] ?? "" })}</>; }\nexport const el = <C labels={{ a: "A" }} k="a" />;`,
    keys: ["Of {a}", "On {a}", "From {a}"],
  },
  {
    label: "unresolved computed reads as JSX props, children and unmutated const literal values",
    code: `const LABELS = { a: "A" };\nfunction Row({ label }: { label: string }) { return <>{label}</>; }\nfunction C({ k, values }: { k: "a"; values: Record<string, string> }) { const row = { label: LABELS[k] }; return <><Row label={values[k] ?? ""} />{values[k]?.trim()}{values[k]}{row.label}<T>Shown</T></>; }\nexport const el = <C k="a" values={{ a: " v " }} />;`,
    keys: ["Shown"],
  },
  {
    label: "Reflect.get(i, key)",
    code: `function C() { const i = useIntl(); const tr = Reflect.get(i, "t"); return <>{tr("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "Reflect.get",
  },
  {
    label: "Reflect.get(i, unresolved key) on an IntlInstance",
    code: `function C({ k }: { k: string }) { const i = useIntl(); const tr = Reflect.get(i, k) as (s: string) => string; return <>{tr("Hidden")}</>; }\nexport const el = <C k="t" />;`,
    fails: "Reflect.get",
  },
  {
    label: 'Reflect.get(...[i, "t"]) with spread arguments on an IntlInstance',
    code: `function C() { const i = useIntl(); const tr = Reflect.get(...([i, "t"] as const)) as (s: string) => string; return <>{tr("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "Reflect.get",
  },
  {
    label: "Reflect.get(record, unresolved key) on an app record",
    code: `function C({ k, fns }: { k: string; fns: Record<string, () => string> }) { const f = Reflect.get(fns, k) as () => string; return <>{f()}</>; }\nexport const el = <C k="a" fns={{ a: () => "x" }} />;`,
    keys: [],
  },
  {
    label: "Function.prototype.call/apply/bind on .t",
    code: `function C() { const i = useIntl(); return <>{i.t.call(i, "Hidden")}</>; }\nexport const el = <C />;`,
    fails: "may only be called",
  },
  {
    label: "Function.prototype.call/apply/bind on t",
    code: `function C() { const t = useT(); return <>{t.apply(null, ["Hidden"])}</>; }\nexport const el = <C />;`,
    fails: "passed or stored",
  },
  // Destructuring and assignment patterns.
  {
    label: "{ t } and { t = d } from a bound IntlInstance",
    code: `function C() { const i = useIntl(); const { t } = i; const { t: u = (m: string) => m } = i; return <>{t("Destructured")}{u("Defaulted")}</>; }\nexport const el = <C />;`,
    keys: ["Destructured", "Defaulted"],
  },
  {
    label: "nested { a: { t } }",
    code: `function C() { const i = useIntl(); const { a: { t } } = { a: i }; return <>{t("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "destructured from something",
  },
  {
    label: "{ t } assignment pattern",
    code: `function C() { const i = useIntl(); let tr: (s: string) => string = (s) => s; ({ t: tr } = i); return <>{tr("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "assigning `{ t }`",
  },
  {
    label: "{ t } as a for-of assignment target",
    code: `function C() { const i = useIntl(); let t: (s: string) => string = (s) => s; for ({ t } of [i]) { void t; } return <>{t("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "assigning `{ t }`",
  },
  {
    label: "{ t } in a for-of declaration",
    code: `function C() { const i = useIntl(); const out: Array<string> = []; for (const { t } of [i]) { out.push(t("Hidden")); } return <>{out}</>; }\nexport const el = <C />;`,
    fails: "destructured from something",
  },
  {
    label: "{ t } in a catch parameter",
    code: `function C() { const i = useIntl(); try { throw i; } catch ({ t }) { return <>{String(t)}</>; } }\nexport const el = <C />;`,
    fails: "catch clause",
  },
  // Enumeration: an IntlInstance's t is not enumerable, so an object spread and a rest never carry it. A function found
  // there would be called with "Hidden", and the runtime would look that key up while the extractor saw nothing. Handed to
  // a call, the instance fails as any argument does (#40).
  {
    label: "Object.values of an IntlInstance",
    code: `function C() { const i = useIntl(); const f = Object.values(i).find((v): v is (s: string) => string => typeof v === "function"); return <>{f?.("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "`i` is an IntlInstance (or a promise of one) used as a value",
  },
  {
    label: "Object.entries of an IntlInstance",
    code: `function C() { const i = useIntl(); const f = Object.entries(i).map(([, v]) => v).find((v): v is (s: string) => string => typeof v === "function"); return <>{f?.("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "`i` is an IntlInstance (or a promise of one) used as a value",
  },
  {
    label: "object spread of an IntlInstance",
    code: `function C() { const i = useIntl(); const f = Object.values({ ...i }).find((v): v is (s: string) => string => typeof v === "function"); return <>{f?.("Hidden")}</>; }\nexport const el = <C />;`,
    keys: [],
  },
  {
    label: "rest of a destructured IntlInstance",
    code: `function C() { const { locale, ...rest } = useIntl(); void locale; const f = Object.values(rest).find((v): v is (s: string) => string => typeof v === "function"); return <>{f?.("Hidden")}</>; }\nexport const el = <C />;`,
    keys: [],
  },
  {
    label: "Object.assign from an IntlInstance",
    code: `function C() { const f = Object.values(Object.assign({}, useIntl())).find((v): v is (s: string) => string => typeof v === "function"); return <>{f?.("Hidden")}</>; }\nexport const el = <C />;`,
    fails: "`useIntl()` is an IntlInstance (or a promise of one) used as a value",
  },
  {
    label: "with statement",
    code: `function C() { const i = useIntl(); with (i) { return <>{t("Hidden")}</>; } }\nexport const el = <C />;`,
    fails: "cannot parse",
  },
];

// Under the package, so row imports resolve its node_modules; one directory per run, so concurrent runs (a watch run
// beside ci:checks) neither overwrite nor delete each other's rows.
const cache = join(import.meta.dirname, "../.cache");
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, "differential-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A catalog with no entries that records each wire key the runtime looks up: lookups test own properties of the
// entries (`Object.hasOwn`), which reaches this trap with the wire key.
function recordingCatalog() {
  const keys: Array<string> = [];
  const entries = new Proxy<Record<string, never>>(
    {},
    {
      getOwnPropertyDescriptor: (_target, prop) => {
        keys.push(String(prop));

        return undefined;
      },
    }
  );
  const compiled = compileCatalog('msgid ""\nmsgstr ""\n', "nb");

  if (compiled._tag !== "Compiled") {
    throw compiled;
  }

  const catalog: Catalog = { ...compiled.catalog, m: entries };

  return { catalog, keys };
}

// The row written to disk and imported, so the runtime runs the text the extractor read.
async function importRow(name: string, code: string): Promise<object> {
  const file = pathToFileURL(join(dir, `${name}.tsx`));
  writeFileSync(file, code);
  // A module namespace has a null prototype, so Object() boxes nothing and `in` narrows it.
  const loaded: unknown = await import(/* @vite-ignore */ file.href);

  return new Object(loaded);
}

// The row's element, loaded and checked outside any try: a setup failure fails the row, never passes as an ending.
async function rowElement(index: number, code: string): Promise<ReactElement> {
  const imported = await importRow(`row-${index}`, HEADER + code);
  const el = "el" in imported ? imported.el : undefined;

  if (!isValidElement(el)) {
    throw new Error(`row ${index} exports no element`);
  }

  return el;
}

/** What one render of a row did: the wire keys it looked up and the messages it reported, in order. */
type Rendered = { readonly keys: ReadonlyArray<string>; readonly reports: ReadonlyArray<string> };

// The row's one render: the module imported, its element checked, and rendered once on a recording catalog.
async function rowRender(index: number, code: string): Promise<Rendered> {
  const el = await rowElement(index, code);
  const reports: Array<string> = [];
  const { catalog, keys } = recordingCatalog();
  renderToStaticMarkup(
    <IntlProvider
      locale="nb"
      catalog={catalog}
      timeZone="UTC"
      onError={(error) => reports.push(error.message)}>
      {el}
    </IntlProvider>
  );

  return { keys, reports };
}

// A lookup the recording catalog misses also reports (not extracted yet), so a `looksUp` ending reads the lookups
// alone, and a `reports` ending the first report with every lookup.
function expectEnding({ keys, reports }: Rendered, expected: RuntimeEnding): void {
  // Neither a lookup nor a report is no ending a <T> has: the row is broken.
  expect(keys.length + reports.length, "the row looked nothing up and reported nothing").toBeGreaterThan(0);

  if (expected.reports === undefined) {
    expect(keys).toEqual(expected.looksUp.map((key) => hashKey(key)));
  } else {
    expect(reports[0]).toEqual(expect.stringContaining(expected.reports));
    expect(keys).toEqual((expected.looksUp ?? []).map((key) => hashKey(key)));
  }
}

// Unit under test: the extractor and the runtime lookup, on the same module text. Oracle: the hand-written key both
// must produce (the runtime looks up its wire key, hashKey of it), the failure the extractor must report for a form
// whose runtime key it cannot know, (a residual) the keys the runtime looks up while the extractor finds none, or, for
// a <T> grammar rule, the extractor's failure and the runtime's hand-written ending (reports, or looks up).
describe("extractor and runtime agree", () => {
  it.each(rows.map((row, i) => [row.label, i, row] as const))("%s", async (_label, i, row) => {
    const extracted = extractMessages(`row-${i}.tsx`, HEADER + row.code);

    if (row.rejects !== undefined) {
      expect(
        extracted._tag === "Failed" ? extracted.failures.map((f) => f.message).join("\n") : extracted.messages
      ).toEqual(expect.stringContaining(row.rejects));
      expectEnding(await rowRender(i, row.code), row.runtime);

      return;
    }

    if (row.fails !== undefined) {
      expect(
        extracted._tag === "Failed" ? extracted.failures.map((f) => f.message).join("\n") : extracted.messages
      ).toEqual(expect.stringContaining(row.fails));

      return;
    }

    expect(
      extracted._tag === "Extracted" ? extracted.messages.map((m) => m.key) : extracted.failures
    ).toEqual(row.keys ?? []);

    const rendered = await rowRender(i, row.code);

    if (row.runtime !== undefined) {
      expectEnding(rendered, row.runtime);

      return;
    }

    expect(rendered.keys).toEqual((row.keys ?? row.misses).map((key) => hashKey(key)));
  });
});

// The Effect service's read forms, in one generator: destructured `{ t }`, `(yield* CurrentIntl).t` and a renamed
// import, extracted and then run with the service provided.
const EFFECT_ROW = `import * as Effect from "effect/Effect";
import { CurrentIntl, CurrentIntl as Translator } from "@elmeragroup/intl/effect";
export const program = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;
  const intl = yield* Translator;
  return [t("Hello, {name}", { name: "Ada" }), (yield* CurrentIntl).t("Inline"), intl.t("Renamed")];
});
`;

// Unit under test: the extractor and the runtime lookup on an Effect program's text. Oracle: the hand-written keys both
// must produce, the runtime's as their wire keys.
describe("extractor and runtime agree on the Effect service", () => {
  it("extracts and looks up the same keys", async () => {
    const expected = ["Hello, {name}", "Inline", "Renamed"];
    const extracted = extractMessages("effect-row.tsx", EFFECT_ROW);
    expect(
      extracted._tag === "Extracted" ? extracted.messages.map((m) => m.key) : extracted.failures
    ).toEqual(expected);

    const imported = await importRow("effect-row", EFFECT_ROW);
    const program = "program" in imported ? imported.program : undefined;

    if (!Effect.isEffect(program)) {
      throw new Error("the Effect row exports no program");
    }

    const { catalog, keys } = recordingCatalog();
    // SAFETY: EFFECT_ROW's program reads only CurrentIntl and cannot fail, which the type of its source states; the
    // dynamic import loses that type.
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off anyUnknownInErrorContext:off - the SAFETY reason above
    const needsIntl = program as Effect.Effect<unknown, never, CurrentIntl>;
    Effect.runSync(
      needsIntl.pipe(Effect.provide(CurrentIntl.layer({ locale: "nb", catalog, timeZone: "UTC" })))
    );

    expect(keys).toEqual(expected.map((key) => hashKey(key)));
  });
});
