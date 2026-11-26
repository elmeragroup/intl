import { describe, expect, it } from "vitest";

import { extractMessages } from "../src/extract";
import {
  APP_T,
  APP_T_IMPORTING,
  AS_VALUE,
  NOT_BOUND,
  NOT_YIELDED,
  PKG,
  UNTRACED_INTL,
  UNTRACED_T,
} from "./extract-expectations";

// An IntlInstance's file of origin, as it reads each form #40 names. Each failure is `line:column message` at the
// position in the source as written (columns 0-based); a clean file is its keys.
function located(file: string, code: string): ReadonlyArray<string> {
  const extracted = extractMessages(file, code);

  return extracted._tag === "Extracted"
    ? extracted.messages.map((m) => m.key)
    : extracted.failures.map((f) => `${f.position.line}:${f.position.column} ${f.message}`);
}

const PASSED_T = "`t` is passed or stored; call it with a literal message where it is used";
const IN_PARAM =
  '`{ t }` destructured in a parameter; call `.t("…")` on an IntlInstance bound in this function, or pass msg() descriptors';
const preIntl = `import { useIntl, useT } from "${PKG}/react";\n`;
// What an instance given as the props of a classic-runtime factory other than React's createElement is told: the copy
// and the runtime rewrites.
const CLASSIC_PROPS = (form: string) =>
  `\`${form}\` is an IntlInstance given as the second argument of a call the extractor cannot bind to React's \`createElement\`, where a classic JSX factory takes its props: under \`@jsxRuntime classic\`, \`<Row {...${form}}>\` compiles to \`React.createElement(Row, ${form})\` with \`React\` a global, or to the \`@jsx\` pragma's factory, which may keep the instance itself as the props, so its \`t\` reaches the child unextracted; copy it yourself, \`<Row {...{ ...${form} }}>\` (\`{ ...${form} }\` in a hand-written call), or use the automatic JSX runtime (or, with \`React\` as the factory, \`import React from "react"\`)`;
// The classic runtime with `React` a global, and with preact's `h` as the `@jsx` factory: `<Row {...intl}>` compiles to
// `factory(Row, intl, ...)`, which may keep the instance as the props.
const classicGlobal = `/** @jsxRuntime classic */\n${preIntl}import { Row } from "./row";\n`;
const classicPreact = `/** @jsxRuntime classic */\n/** @jsx h */\nimport { h } from "preact";\n${preIntl}import { Row } from "./row";\n`;
const preCreate = `import { createIntl } from "${PKG}/core";\nimport { cfg } from "./cfg";\n`;
const preType = `import type { IntlInstance } from "${PKG}/react";\n`;
const preEffectOnly = `import * as Effect from "effect/Effect";\nimport { CurrentIntl } from "${PKG}/effect";\n`;

// Unit under test: extraction of a file that binds an IntlInstance and hands it on (#40). Oracle: the hand-written truth
// table of the change: the instance stays in the file that binds it, as `t` does, so every use other than its own
// members, a declaration, a dependency array, an object spread (the props of a createElement bound to `react` too) or a
// discarded or `void` value fails there, once per site, with AS_VALUE's message, or CLASSIC_PROPS' as the props of any
// other factory in a `@jsxRuntime classic` file; the files that receive one read as they did, and the failure is at the
// parent.
describe("an IntlInstance used as a value", () => {
  it.each([
    [
      "a JSX prop",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Row } from "./row";\nexport function Page() { const intl = useIntl(); return <Row intl={intl} />; }`,
      [`3:67 ${AS_VALUE("intl")}`],
    ],
    [
      "a factory call as a JSX prop",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Row } from "./row";\nexport function Page() { return <Row intl={useIntl()} />; }`,
      [`3:43 ${AS_VALUE("useIntl()")}`],
    ],
    [
      "a renamed factory's call, by its local name",
      "page.tsx",
      `import { useIntl as u } from "${PKG}/react";\nimport { Row } from "./row";\nexport function P() { return <Row intl={u()} />; }`,
      [`3:40 ${AS_VALUE("u()")}`],
    ],
    [
      "a context value",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { IntlCtx } from "./intl-context";\nexport function Page({ children }) { const intl = useIntl(); return <IntlCtx.Provider value={intl}>{children}</IntlCtx.Provider>; }`,
      [`3:93 ${AS_VALUE("intl")}`],
    ],
    [
      "a shorthand property of an outlet context",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Outlet } from "react-router";\nexport function Page() { const intl = useIntl(); return <Outlet context={{ intl }} />; }`,
      [`3:75 ${AS_VALUE("intl")}`],
    ],
    [
      "an outlet context",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Outlet } from "react-router";\nexport function Page() { const intl = useIntl(); return <Outlet context={intl} />; }`,
      [`3:73 ${AS_VALUE("intl")}`],
    ],
    [
      "a call argument",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { formatDue } from "./due";\nexport function Page() { const intl = useIntl(); return <p>{formatDue(intl, 0)}</p>; }`,
      [`3:70 ${AS_VALUE("intl")}`],
    ],
    [
      "yield* CurrentIntl passed",
      "e.ts",
      `${preEffectOnly}import { render } from "./render";\nexport const p = Effect.gen(function* () { return render(yield* CurrentIntl); });`,
      [`4:57 ${AS_VALUE("yield* CurrentIntl")}`],
    ],
    [
      "an instance from yield* CurrentIntl passed to a helper",
      "h.ts",
      `${preEffectOnly}import { render } from "./render";\nexport const h = Effect.gen(function* () { const intl = yield* CurrentIntl; return render(intl); });`,
      [`4:90 ${AS_VALUE("intl")}`],
    ],
    [
      "an exported binding, at its initializer",
      "intl.ts",
      `${preCreate}export const intl = createIntl(cfg);`,
      [`3:20 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "an export specifier alone, once",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nexport { intl };`,
      [`4:9 ${AS_VALUE("intl")}`],
    ],
    [
      "an export specifier and a default export, once per site",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nexport { intl };\nexport default intl;`,
      [`4:9 ${AS_VALUE("intl")}`, `5:15 ${AS_VALUE("intl")}`],
    ],
    [
      "a renamed export specifier, once",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nexport { intl as myIntl };`,
      [`4:9 ${AS_VALUE("intl")}`],
    ],
    [
      "two export specifiers, once each",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nexport { intl as first, intl as second };`,
      [`4:9 ${AS_VALUE("intl")}`, `4:24 ${AS_VALUE("intl")}`],
    ],
    [
      "a state setter's argument",
      "page.tsx",
      `import { useState } from "react";\nimport { createIntl } from "${PKG}/core";\nimport { cfg } from "./cfg";\nexport function Page() { const [i, setI] = useState(null); setI(createIntl(cfg)); return null; }`,
      [`4:64 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "a store's initial value",
      "p.tsx",
      `${preIntl}import { useState } from "react";\nexport function P() { const intl = useIntl(); const [s] = useState([intl]); return null; }`,
      [`3:68 ${AS_VALUE("intl")}`],
    ],
    [
      "a promise of one, through .then",
      "p.tsx",
      `import { getIntl } from "${PKG}/server";\nimport { Row } from "./row";\nexport const P = () => getIntl().then((i) => <Row intl={i} />);`,
      [`3:23 ${AS_VALUE("getIntl()")}`],
    ],
    [
      "a bound promise, through .then",
      "p.ts",
      `import { getIntl } from "${PKG}/server";\nimport { pass } from "./pass";\nconst p = getIntl(); p.then(pass);`,
      [`3:21 ${AS_VALUE("p")}`],
    ],
    [
      "an inherited member that returns the instance (.valueOf())",
      "p.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Row } from "./row";\nexport function P() { const intl = useIntl(); return <Row intl={intl.valueOf()} />; }`,
      [`3:64 ${AS_VALUE("intl")}`],
    ],
    [
      "getIntl() inside Promise.all",
      "page.tsx",
      `import { getIntl } from "${PKG}/server";\nimport { load } from "./load";\nexport default async function P() { const [intl, data] = await Promise.all([getIntl(), load()]); return <p>{intl.format.number(data.n)}</p>; }`,
      [`3:76 ${AS_VALUE("getIntl()")}`],
    ],
    [
      "an Effect layer built from an instance, beside the service's own failure",
      "l.ts",
      `${preCreate}import * as Layer from "effect/Layer";\nimport { CurrentIntl } from "${PKG}/effect";\nexport const L = Layer.succeed(CurrentIntl, createIntl(cfg));`,
      [`5:31 ${NOT_YIELDED}`, `5:44 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "an instance provided as the service, beside the service's own failure",
      "l.ts",
      `${preCreate}${preEffectOnly}export const run = (e) => e.pipe(Effect.provideService(CurrentIntl, createIntl(cfg)));`,
      [`5:55 ${NOT_YIELDED}`, `5:68 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "a request context's value",
      "context.ts",
      `${preCreate}export const createContext = () => ({ intl: createIntl(cfg) });`,
      [`3:44 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "a useMemo callback's result, beside its receiver's failure",
      "page.tsx",
      `import { useMemo } from "react";\nimport { createIntl } from "${PKG}/core";\nexport function Page({ cfg }) { const intl = useMemo(() => createIntl(cfg), [cfg]); return intl.t("X"); }`,
      [`3:59 ${AS_VALUE("createIntl(…)")}`, `3:91 ${UNTRACED_INTL("intl")}`],
    ],
    [
      "a logical operand",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { Row } from "./row";\nexport function Page({ x }) { const intl = x ?? useIntl(); return <Row intl={intl} />; }`,
      [`3:48 ${AS_VALUE("useIntl()")}`],
    ],
    [
      "an instance a test hands to its unit",
      "row.test.tsx",
      `${preCreate}import { render } from "@testing-library/react";\nimport { Row } from "./row";\nrender(<Row intl={createIntl(cfg)} />);`,
      [`5:18 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "a logged instance",
      "p.tsx",
      `${preIntl}export function P() { const intl = useIntl(); console.log(intl); return null; }`,
      [`2:58 ${AS_VALUE("intl")}`],
    ],
    [
      "typeof, a negation and a template",
      "p.ts",
      `${preCreate}const intl = createIntl(cfg);\nexport const a = typeof intl;\nexport const b = !intl;\nexport const c = \`\${intl}\`;`,
      [`4:24 ${AS_VALUE("intl")}`, `5:18 ${AS_VALUE("intl")}`, `6:20 ${AS_VALUE("intl")}`],
    ],
    [
      "a multi-line factory call, by its form",
      "p.ts",
      `import { createIntl } from "${PKG}/core";\nimport { use } from "./use";\nuse(createIntl({\n  locale: "en",\n  catalog: {},\n}));`,
      [`3:4 ${AS_VALUE("createIntl(…)")}`],
    ],
    [
      "an un-awaited and an awaited getIntl() passed",
      "p.tsx",
      `import { getIntl } from "${PKG}/server";\nimport { use } from "./use";\nexport default async function P() { use(getIntl()); use(await getIntl()); return null; }`,
      [`3:40 ${AS_VALUE("getIntl()")}`, `3:62 ${AS_VALUE("getIntl()")}`],
    ],
    [
      "a factory call in a dependency array",
      "p.tsx",
      `${preIntl}import { useEffect } from "react";\nexport function P() { useEffect(() => {}, [useIntl()]); return null; }`,
      [`3:43 ${AS_VALUE("useIntl()")}`],
    ],
    [
      "[intl] in a member facade's array",
      "p.tsx",
      `${preIntl}import * as Hooks from "./hooks";\nexport function P() { const intl = useIntl(); Hooks.useEffect(() => { document.title = intl.t("Home"); }, [intl]); return null; }`,
      [`3:107 ${AS_VALUE("intl")}`],
    ],
    [
      "[intl] in a member facade's array, its callback not reading it",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport * as Hooks from "./hooks";\nexport function Page() { const intl = useIntl(); Hooks.useEffect(() => {}, [intl]); }`,
      [`3:76 ${AS_VALUE("intl")}`],
    ],
    [
      "a child under the classic JSX runtime, React's createElement's third argument",
      "page.tsx",
      `/** @jsxRuntime classic */\nimport React from "react";\n${preIntl}import { Box } from "./box";\nexport function P() { const intl = useIntl(); return <Box>{intl}</Box>; }`,
      [`5:59 ${AS_VALUE("intl")}`],
    ],
    [
      "the props of jsx() from react/jsx-runtime, which keeps the object as the props",
      "p.ts",
      `${preIntl}import { jsx } from "react/jsx-runtime";\nimport { Row } from "./row";\nexport function P() { const intl = useIntl(); return jsx(Row, intl); }`,
      [`4:62 ${AS_VALUE("intl")}`],
    ],
    [
      "the props of a createElement not bound to react",
      "p.ts",
      `${preIntl}import { createElement } from "./h";\nimport { Row } from "./row";\nexport function P() { const intl = useIntl(); return createElement(Row, intl); }`,
      [`4:72 ${AS_VALUE("intl")}`],
    ],
    [
      "a JSX spread under the classic runtime with React a global, the props of its createElement",
      "page.tsx",
      `${classicGlobal}export function P() { const intl = useIntl(); return <Row {...intl}>{intl.t("Keep")}</Row>; }`,
      [`4:62 ${CLASSIC_PROPS("intl")}`],
    ],
    [
      "a JSX spread under the classic runtime with preact's h as the @jsx factory, the props of h",
      "page.tsx",
      `${classicPreact}export function P() { const intl = useIntl(); return <Row {...intl}>{intl.t("Keep")}</Row>; }`,
      [`6:62 ${CLASSIC_PROPS("intl")}`],
    ],
    [
      "an argument after a spread before React's createElement's props slot, which may be the children",
      "p.ts",
      `import React from "react";\n${preIntl}import { Row } from "./row";\nexport function P() { const intl = useIntl(); return React.createElement(...[Row, null], intl); }`,
      [`4:89 ${AS_VALUE("intl")}`],
    ],
    [
      "the target of a compound assignment, which reads it",
      "p.ts",
      `${preCreate}import { other } from "./other";\nlet intl = createIntl(cfg);\nintl ??= other;\nintl ||= other;\nintl.t("Due");`,
      [`5:0 ${AS_VALUE("intl")}`, `6:0 ${AS_VALUE("intl")}`],
    ],
  ] as const)("fails %s, at the expression", (_label, file, code, expected) => {
    expect(located(file, code)).toEqual(expected);
  });

  // The files that receive an instance, each on its own: none of them changes, so the failure is at the parent.
  it.each([
    [
      "a destructured parameter, untyped",
      "row.jsx",
      `export function Row({ intl }) { const { t } = intl; return <td>{t("Due date")}</td>; }`,
      [],
    ],
    [
      "a destructured parameter typed from an app module",
      "row.tsx",
      `import type { RowProps } from "./types";\nexport function Row({ intl }: RowProps) { const { t } = intl; return <td>{t("Due date")}</td>; }`,
      [],
    ],
    [
      "a destructured parameter typed from the package",
      "row.tsx",
      `${preType}export function Row({ intl }: { intl: IntlInstance }) { const { t } = intl; return <td>{t("Due date")}</td>; }`,
      [`2:62 ${NOT_BOUND}`, `2:88 ${UNTRACED_T}`],
    ],
    [
      "{ t } in the parameter, untyped",
      "row.jsx",
      `export function Row({ intl: { t } }) { return <td>{t("Due date")}</td>; }`,
      [],
    ],
    [
      "{ t } in the parameter, typed from the package",
      "row.tsx",
      `${preType}export function Row({ intl: { t } }: { intl: IntlInstance }) { return <td>{t("Due date")}</td>; }`,
      [`2:20 ${IN_PARAM}`, `2:75 ${UNTRACED_T}`],
    ],
    [
      "{ t } from a parameter's member, untyped",
      "row.jsx",
      `export function Row(props) { const { t } = props.intl; return <td>{t("Due date")}</td>; }`,
      [],
    ],
    [
      "{ t } from a parameter's member, typed from the package",
      "row.tsx",
      `${preType}export function Row(props: { intl: IntlInstance }) { const { t } = props.intl; return <td>{t("Due date")}</td>; }`,
      [`2:59 ${NOT_BOUND}`, `2:91 ${UNTRACED_T}`],
    ],
    [
      "a local context read",
      "row.jsx",
      `import { createContext, useContext } from "react";\nconst IntlCtx = createContext(null);\nexport function Row() { const { t } = useContext(IntlCtx); return <td>{t("Due date")}</td>; }`,
      [],
    ],
    [
      "a local context read, typed from the package",
      "row.tsx",
      `${preType}import { createContext, useContext } from "react";\nconst IntlCtx = createContext<IntlInstance | null>(null);\nexport function Row() { const { t } = useContext(IntlCtx)!; return <td>{t("Due date")}</td>; }`,
      [`4:30 ${NOT_BOUND}`, `4:72 ${UNTRACED_T}`],
    ],
    [
      "an imported context read, typed from the package",
      "row.tsx",
      `${preType}import { useContext } from "react";\nimport { IntlCtx } from "./intl-context";\nexport function Row() { const { t } = useContext(IntlCtx) as IntlInstance; return <td>{t("Due date")}</td>; }`,
      [`4:30 ${NOT_BOUND}`, `4:87 ${UNTRACED_T}`],
    ],
    [
      "a formatter read off a typed parameter",
      "row.tsx",
      `import type { IntlInstance } from "${PKG}/core";\nexport function Row({ intl }: { intl: IntlInstance }) { return <td>{intl.format.number(1)}</td>; }`,
      [],
    ],
    [
      "an outlet context, untyped",
      "row.jsx",
      `import { useOutletContext } from "react-router";\nexport function Row() { const { t } = useOutletContext(); return <td>{t("Invoice")}</td>; }`,
      [],
    ],
    [
      "an outlet context typed from the package",
      "row.tsx",
      `${preType}import { useOutletContext } from "react-router";\nexport function Row() { const { t } = useOutletContext<IntlInstance>(); return <td>{t("Invoice")}</td>; }`,
      [],
    ],
    [
      "an app module's hook",
      "row.tsx",
      `import { useAppIntl } from "./intl";\nexport function Row() { const { t } = useAppIntl(); return <td>{t("Due date")}</td>; }`,
      [`2:64 ${APP_T("./intl")}`],
    ],
    [
      "an app module's hook, typed from the package",
      "row.tsx",
      `${preType}import { useAppIntl } from "./intl";\nexport function Row() { const { t } = useAppIntl(); return <td>{t("Due date")}</td>; }`,
      [`3:30 ${NOT_BOUND}`, `3:64 ${APP_T_IMPORTING("./intl")}`],
    ],
    [
      "a time sample's t in an importing file",
      "anim.ts",
      `import { msg } from "${PKG}/core";\nexport const D = msg("D");\nexport function at(sample: { t: number }) { const { t } = sample; return t * 2; }`,
      [`3:50 ${NOT_BOUND}`],
    ],
    [
      "a time sample's t",
      "anim.ts",
      `export function at(sample: { t: number }) { const { t } = sample; return t * 2; }`,
      [],
    ],
    [
      "a test callback's t",
      "x.test.ts",
      `import { test } from "vitest";\ntest("x", ({ t }) => { t("k"); });`,
      [],
    ],
    [
      "a react-i18next HOC child's { t }",
      "child.tsx",
      `import { withTranslation } from "react-i18next";\nfunction Child({ t }) { return <p>{t("hello")}</p>; }\nexport default withTranslation()(Child);`,
      [],
    ],
    [
      "another library's t received as a prop",
      "child.tsx",
      `export function Child(props: { t: (k: string) => string }) { const { t } = props; return <p>{t("hello")}</p>; }`,
      [],
    ],
    [
      "a destructured parameter's .t(…)",
      "row.jsx",
      `export function Row({ intl }) { return <td>{intl.t("Due date")}</td>; }`,
      [`1:44 ${UNTRACED_INTL("intl")}`],
    ],
  ] as const)("reads %s as it did", (_label, file, code, expected) => {
    expect(located(file, code)).toEqual(expected);
  });

  it.each([
    [
      "its members passed on",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { due } from "./due";\nexport function Page() { const intl = useIntl(); return <p>{due(intl.format, intl.locale)}</p>; }`,
      [],
    ],
    [
      "its t.from",
      "page.tsx",
      `import { msg, useIntl } from "${PKG}/react";\nconst D = msg("Due");\nexport function Page() { const intl = useIntl(); return intl.t.from(D); }`,
      ["Due"],
    ],
    [
      "an object spread of an awaited getIntl()",
      "layout.tsx",
      `import { getIntl } from "${PKG}/server";\nimport { IntlProvider } from "${PKG}/react";\nexport default async function L({ children }) { return <IntlProvider {...await getIntl()}>{children}</IntlProvider>; }`,
      [],
    ],
    [
      "a discarded await",
      "a.ts",
      `import { getIntl } from "${PKG}/server";\nexport async function a() { await getIntl(); }`,
      [],
    ],
    [
      "a binding cleared by a plain assignment, which writes it",
      "p.ts",
      `import { createIntl, type IntlInstance } from "${PKG}/core";\nimport { cfg } from "./cfg";\nlet intl: IntlInstance | undefined = createIntl(cfg);\nintl?.t("Due");\nintl = undefined;`,
      ["Due"],
    ],
    [
      "a helper that awaits getIntl() and returns its format, inside Promise.all",
      "page.tsx",
      `import { getIntl } from "${PKG}/server";\nimport { load } from "./load";\nasync function money() { const { format } = await getIntl(); return format; }\nexport default async function P() { const [format, data] = await Promise.all([money(), load()]); return <p>{format.number(data.n)}</p>; }`,
      [],
    ],
    [
      "an instance called as t, with only its untraced-t failure",
      "p.tsx",
      `${preIntl}export function P() { const t = useIntl(); return t("X"); }`,
      [`2:50 ${UNTRACED_T}`],
    ],
    [
      "a received parameter passed on",
      "row.tsx",
      `import type { IntlInstance } from "${PKG}/react";\nimport { Cell } from "./cell";\nexport function Row({ intl }: { intl: IntlInstance }) { return <Cell intl={intl} />; }`,
      [],
    ],
    [
      "another library's t passed down",
      "page.tsx",
      `import { useTranslation } from "react-i18next";\nimport { useT } from "${PKG}/react";\nimport { Child } from "./child";\nexport function Page() { const t = useT(); const { t: i18nT } = useTranslation(); return <Child t={i18nT} title={t("Title")} />; }`,
      ["Title"],
    ],
    [
      "an exported pattern over an instance's members",
      "intl.ts",
      `${preCreate}export const { format } = createIntl(cfg);`,
      [],
    ],
    [
      "a re-export from another module beside a local instance",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nintl.t("Due");\nexport { intl as x } from "./other";`,
      ["Due"],
    ],
    [
      "a re-export of t from another module beside a bound t",
      "t.ts",
      `import { getT } from "${PKG}/server";\nconst t = await getT();\nt("A");\nexport { t as x } from "./other";`,
      ["A"],
    ],
    [
      "a namespace re-export named intl beside a local instance",
      "intl.ts",
      `${preCreate}const intl = createIntl(cfg);\nintl.t("A");\nexport * as intl from "./other";`,
      ["A"],
    ],
    [
      "a namespace re-export named t beside a bound t",
      "t.ts",
      `import { getT } from "${PKG}/server";\nconst t = await getT();\nt("A");\nexport * as t from "./other";`,
      ["A"],
    ],
    // The rewrites the message names.
    [
      "an instance created per procedure from the context's config",
      "router.ts",
      `${preCreate}import { p } from "./trpc";\nexport const r = p.query(({ ctx }) => { const { t } = createIntl(ctx.intlConfig); return t("Hello"); });`,
      ["Hello"],
    ],
    [
      "a JSX spread under the classic runtime with React imported, which compiles to its createElement's props",
      "page.tsx",
      `/** @jsxRuntime classic */\nimport React from "react";\n${preIntl}import { LocaleBoundary } from "./boundary";\nexport function P() { const intl = useIntl(); return <LocaleBoundary {...intl}>{intl.t("Due date")}</LocaleBoundary>; }`,
      ["Due date"],
    ],
    [
      "a JSX spread under the automatic runtime, which copies it into the props object",
      "page.tsx",
      `${preIntl}import { Row } from "./row";\nexport function P() { const intl = useIntl(); return <Row {...intl}>{intl.t("Keep")}</Row>; }`,
      ["Keep"],
    ],
    [
      "a copy spread under the classic runtime with React a global",
      "page.tsx",
      `${classicGlobal}export function P() { const intl = useIntl(); return <Row {...{ ...intl }}>{intl.t("Keep")}</Row>; }`,
      ["Keep"],
    ],
    [
      "a copy spread under the classic runtime with preact's h as the @jsx factory",
      "page.tsx",
      `${classicPreact}export function P() { const intl = useIntl(); return <Row {...{ ...intl }}>{intl.t("Keep")}</Row>; }`,
      ["Keep"],
    ],
    [
      "a void operand",
      "a.ts",
      `import { getIntl } from "${PKG}/server";\nexport async function a() { void getIntl(); void (await getIntl()); }`,
      [],
    ],
    [
      "a void operand passed, whose value is undefined",
      "a.ts",
      `import { getIntl } from "${PKG}/server";\nimport { f } from "./f";\nexport async function a() { const intl = await getIntl(); f(void intl); }`,
      [],
    ],
    [
      "import.meta beside an instance named meta",
      "og.tsx",
      `import { getIntl } from "${PKG}/server";\nexport default async function P() { const meta = await getIntl(); const u = new URL("./og.png", import.meta.url); return meta.t("Invoices"); }`,
      ["Invoices"],
    ],
    [
      "new.target beside an instance named target",
      "n.ts",
      `${preCreate}export function F() { const target = createIntl(cfg); if (!new.target) return null; return target.t("Invoices"); }`,
      ["Invoices"],
    ],
    [
      "import.meta beside a t named meta",
      "m.tsx",
      `${preIntl}export function P() { const meta = useT(); const u = import.meta.url; return meta("Invoices"); }`,
      ["Invoices"],
    ],
    [
      "new.target beside a t named target",
      "n.tsx",
      `${preIntl}export function P() { const target = useT(); if (!new.target) return null; return target("Invoices"); }`,
      ["Invoices"],
    ],
  ] as const)("allows %s", (_label, file, code, expected) => {
    expect(located(file, code)).toEqual(expected);
  });

  // Exports have one owner each: an exported t is checkExport's alone, as an exported instance is checkInstance's.
  it("reports an exported t once", () => {
    expect(
      located("t.ts", `import { getT } from "${PKG}/server";\nconst t = await getT();\nexport { t };`)
    ).toEqual([
      "3:9 exporting `t` hides its call sites; call it in this module, or export msg() descriptors",
    ]);
  });
});

// Unit under test: the dependency-array exemption for `[t]` and `[intl]` (#40). Oracle: the hand-written truth table:
// React's six dependency hooks, bound to a `react` import (named, renamed, or a member of its default or namespace import),
// at their dependency argument, which is last; a bare `use*` callee not bound to `react`, called with two or more
// arguments, at its last; nothing else, so an array a hook may keep (state, a ref, a reducer's initial state) fails.
describe("a dependency array", () => {
  const deps = `import { useT, useIntl } from "${PKG}/react";\n`;

  it.each([
    [
      "React.useEffect(f, [t]) through a namespace import",
      `import * as React from "react";\nexport function P() { const t = useT(); React.useEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
    ],
    [
      "React.useEffect(f, [t]) through a default import",
      `import React from "react";\nexport function P() { const t = useT(); React.useEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
    ],
    [
      "React.useCallback(f, [t])",
      `import * as React from "react";\nexport function P() { const t = useT(); const f = React.useCallback(() => t("Home"), [t]); return f; }`,
    ],
    [
      "a renamed useMemo with [t]",
      `import { useMemo as memo } from "react";\nexport function P() { const t = useT(); const v = memo(() => t("Home"), [t]); return v; }`,
    ],
    [
      "a renamed useMemo with [intl]",
      `import { useMemo as memo } from "react";\nexport function P() { const intl = useIntl(); const v = memo(() => intl.t("Home"), [intl]); return v; }`,
    ],
    [
      "React.useEffect(f, [intl])",
      `import * as React from "react";\nexport function P() { const intl = useIntl(); React.useEffect(() => { document.title = intl.t("Home"); }, [intl]); return null; }`,
    ],
    [
      "useEffect(f, [intl])",
      `import { useEffect } from "react";\nexport function P() { const intl = useIntl(); useEffect(() => { document.title = intl.t("Home"); }, [intl]); return null; }`,
    ],
    [
      "useLayoutEffect(f, [t])",
      `import { useLayoutEffect } from "react";\nexport function P() { const t = useT(); useLayoutEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
    ],
    [
      "React.useLayoutEffect(f, [intl])",
      `import * as React from "react";\nexport function P() { const intl = useIntl(); React.useLayoutEffect(() => { document.title = intl.t("Home"); }, [intl]); return null; }`,
    ],
    [
      "useInsertionEffect(f, [t])",
      `import { useInsertionEffect } from "react";\nexport function P() { const t = useT(); useInsertionEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
    ],
    [
      "useImperativeHandle(ref, f, [intl])",
      `import { useImperativeHandle } from "react";\nexport function P({ ref }) { const intl = useIntl(); useImperativeHandle(ref, () => ({ title: intl.t("Home") }), [intl]); return null; }`,
    ],
    [
      "a bare custom hook with [t]",
      `import { useAsync } from "react-use";\nexport function P() { const t = useT(); useAsync(async () => t("Home"), [t]); return null; }`,
    ],
    [
      "an app module's effect hook with [t]",
      `import { useIsomorphicLayoutEffect } from "./hooks";\nexport function P() { const t = useT(); useIsomorphicLayoutEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
    ],
    [
      "a bare custom hook with [intl]",
      `import { useAsync } from "react-use";\nexport function P() { const intl = useIntl(); useAsync(async () => intl.t("Home"), [intl]); return null; }`,
    ],
    [
      "a member facade given a callback that lists [t]",
      `import { useCallback } from "react";\nimport * as Hooks from "./hooks";\nexport function P() { const t = useT(); const cb = useCallback(() => { document.title = t("Home"); }, [t]); Hooks.useEffect(cb, [cb]); return null; }`,
    ],
  ] as const)("allows %s", (_label, code) => {
    expect(located("p.tsx", deps + code)).toEqual(["Home"]);
  });

  // The stated limit: a bare custom hook may keep its last argument, and a file that does not import the package
  // destructures `{ t }` from it unchecked.
  it.each([
    [
      "a bare custom hook that keeps its array",
      "page.tsx",
      `import { useIntl } from "${PKG}/react";\nimport { useStore } from "./hooks";\nexport function Page() { const intl = useIntl(); useStore(() => {}, [intl]); }`,
    ],
    [
      "the module that keeps it",
      "hooks.js",
      `let current;\nexport function useEffect(cb, deps) { current = deps[0]; }\nexport function useStore(cb, deps) { current = deps[0]; }\nexport function Row() { const { t } = current; return t("Due"); }`,
    ],
  ] as const)("leaves %s (a stated limit)", (_label, file, code) => {
    expect(located(file, code)).toEqual([]);
  });

  it.each([
    [
      "useState([t]) from react",
      `import { useState } from "react";\nexport function P() { const t = useT(); const [s] = useState([t]); return null; }`,
      "3:62",
    ],
    [
      "useState([t]) with no import",
      `export function P() { const t = useT(); const [s] = useState([t]); return null; }`,
      "2:62",
    ],
    [
      "useRef([t])",
      `import { useRef } from "react";\nexport function P() { const t = useT(); const r = useRef([t]); return null; }`,
      "3:58",
    ],
    [
      "a renamed useState(0, [t])",
      `import { useState as useS } from "react";\nexport function P() { const t = useT(); useS(0, [t]); return null; }`,
      "3:49",
    ],
    [
      "a stored [t] read back under another name",
      `import { useState } from "react";\nexport function P() { const t = useT(); const [[tr]] = useState([t]); return tr("X"); }`,
      "3:65",
    ],
    [
      "a stored [t] passed on",
      `import { useState } from "react";\nimport { Row } from "./row";\nexport function P() { const t = useT(); const [s] = useState([t]); return <Row s={s} />; }`,
      "4:62",
    ],
    [
      "useEffect([t]) with one argument",
      `import { useEffect } from "react";\nexport function P() { const t = useT(); useEffect([t]); return null; }`,
      "3:51",
    ],
    [
      "useReducer(r, [t])",
      `import { useReducer } from "react";\nexport function P() { const t = useT(); const [s] = useReducer((x) => x, [t]); return null; }`,
      "3:74",
    ],
    [
      "useImperativeHandle(ref, [t]), last but not at its slot",
      `import { useImperativeHandle } from "react";\nexport function P({ ref }) { const t = useT(); useImperativeHandle(ref, [t]); return null; }`,
      "3:73",
    ],
    [
      "useEffect(f, [t], 1), at its slot but not last",
      `import { useEffect } from "react";\nexport function P() { const t = useT(); useEffect(() => {}, [t], 1); return null; }`,
      "3:61",
    ],
    [
      "a member facade's [t]",
      `import * as Hooks from "./hooks";\nexport function P() { const t = useT(); Hooks.useEffect(() => { document.title = t("Home"); }, [t]); return null; }`,
      "3:96",
    ],
    [
      "a member facade's [t], its callback not reading it",
      `import * as Hooks from "./hooks";\nexport function Page() { const t = useT(); Hooks.useEffect(() => {}, [t]); }`,
      "3:70",
    ],
  ] as const)("fails %s", (_label, code, position) => {
    expect(located("p.tsx", deps + code)).toEqual([`${position} ${PASSED_T}`]);
  });
});
