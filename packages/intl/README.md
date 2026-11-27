# @elmeragroup/intl

Source-keyed i18n for React. Code is written in English, as hooks or JSX; a message is identified by its English source plus an optional context, and looked up by a short hash of that key in the locale's compiled catalog. The runtime has no ICU parser: it formats only compiled catalogs. Locale switches in place.

Extraction, PO catalogs, the catalog compiler and its loaders, the `elmera-intl` CLI, lint and the Vitest catalog check live in [`@elmeragroup/intl-tools`](../intl-tools/README.md): its deny-by-default extractor writes the POs, the host compiles a `*.po` import into a catalog, and `check` proves them in sync and compilable. Apps depend on this package and take the tools as a devDependency.

## Peer dependencies

`react` `^19.0.0`, and for each host adapter its framework, an optional peer: `next` `^16.4.0` for `/next` and `/next/server`, `@tanstack/react-router` `^1.170.0` for `/start`, and `effect` `^4.1.3` for `/effect`. With `/start`, keep `@tanstack/react-start` and the router it pins aligned, since each react-start release depends on one exact router version; the tested floor pair is react-start 1.168.0 with router 1.170.0. CI tests each range at its floor and at the version of its top major the workspace pins ([CONTRIBUTING.md, Peer ranges](../../CONTRIBUTING.md#peer-ranges)). An installed optional peer outside its range is a peer conflict, which npm can refuse (`ERESOLVE`, for example when the app pins that version itself), and pnpm reports as a warning, or as an error with `strictPeerDependencies`.

## Setup

Three touches per app:

1. `elmera-intl.json` beside the app's package.json (see the tools README's CLI section).
2. The host integration from `@elmeragroup/intl-tools`: Vite `intl()`, or Next `export default withIntl(config, { dir: import.meta.dirname })` in `next.config.ts` with `elmera-intl check && next build` and `elmera-intl extract --watch` beside `next dev` (tools README, "Hosts"), and the server adapter's `loadCatalog` importing the locale's PO (`./intl/nb.po`, `./intl/nb.po?source` for `en`).
3. `<IntlProvider>` in the root layout (Next) or root route (Start), and `useLocaleSwitch(persist)` where the language is chosen (see "Adapter interface" below).

## Engines

The runtime's floor is ES2022: its own source calls no built-in later than ES2022. The build lowers syntax to ES2022
(tsdown's `target`) but adds no polyfill, so a later built-in would throw on an older engine. `pnpm type-check` (not
`pnpm tcw`) type-checks `src` against the ES2022 library (`tsconfig.floor.json`), and a call such as `toSorted`,
`Object.groupBy`, a Set method or an iterator helper fails it, naming the fix (an ES2022 equivalent, never a higher
`lib`). The later built-ins that `@types/node` and Effect's declarations add to that program (`DisposableStack`,
`Float16Array`, `Symbol.dispose` and the like) fail lint instead, as does a `using` or `await using` declaration, which
those declarations let through on any native iterator. The package declares no `engines`.

Neither gate sees `DataView`'s float16 methods, a built-in reached through `globalThis`, the Node globals `@types/node`
declares, the DOM's APIs, the `Intl.NumberFormat` options later than ES2022 a number style passes through as written
(`roundingMode`, `useGrouping: "always"`; `cachedNumberFormat` in `src/icu.ts` says what an ES2022 engine does with
them), or the third-party code bundled into `dist/internal/formatter.js`.

## API

```tsx
import { T, Val, Plural, Select, useT, useFormat, useIntl, msg, createIntl, IntlProvider } from "@elmeragroup/intl/react";
import { getT, getFormat, getIntl } from "@elmeragroup/intl/server";

<T>Hello <Val name={user.firstName} />, read the <a href="/terms">terms</a>.</T>   // key: Hello {name}, read the <x0>terms</x0>.
<T>You have <Plural count={n} _0="no orders" one="# order" other="# orders" /></T>
<T>Sold to this <b><Select subject={subject} _company="company" _private="person" other="customer" /></b></T>   // key: Sold to this <x0>{subject, select, company {company} private {person} other {customer}}</x0>
<T context="verb">Open</T>

const t = useT();                 // client, sync server and directive-less shared components
const t = await getT();           // async server components
t("Hello {name}", { name });      // string literal only; values typed from the literal

const STATUS = { open: msg("Open"), closed: msg("Closed", { context: "status" }) };
t.from(STATUS[status]);           // descriptors: only msg() makes one

const intl = createIntl({ locale, catalog, timeZone, formats });   // Effect, tRPC, scripts; catalog from a *.po import or loadCatalog
intl.t("Order {id}", { id });   // plain {id} takes text: String(n), or "Order {n, number}" for a number

const format = useFormat();       // await getFormat() in async server components; intl.format outside React
format.dateTime(date, "long");    // a named format from `formats`, in `timeZone`
format.number(n, { style: "unit", unit: "kilobyte" });
format.relativeTime(date, now);   // `now` is required: pass the app's clock
format.list(names, { type: "conjunction" });
```

The public subpaths; the `/internal/*` subpaths exist for `@elmeragroup/intl-tools` only and carry no semver promise.

| Subpath                 | Exports                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/core`                 | `createIntl`, `msg`, `keyOf`, `serialize`, `SERIALIZER_VERSION`, `createLocaleSwitcher`, `resolveIntlConfig`, `negotiateLocale` (Accept-Language), types (`IntlInstance`, `Translate`, `Descriptor`, `Catalog`, `Formats`, `IntlConfig`, `ServerAdapter`, `RequestConfig`, `SwitchOutcome`). No React.      |
| `/react`                | `IntlProvider`, `useIntl`, `T`, `Val`, `Plural`, `Select`, `useT`, `useFormat`, `msg`, `createIntl`. Same list under `default` and `react-server`; the `react-server` build reads the request's `IntlInstance` (`React.cache`), and its `IntlProvider` is the client one, so a server layout can render it. |
| `/server`               | `getIntl`, `getT`, `getFormat`, read from the host's request config (Next: `withIntl` aliases it to the app's `intl/request.ts`).                                                                                                                                                                           |
| `/next`, `/next/server` | `useLocaleSwitch(persist)` (client); `createRequestConfig(adapter, { onError })` (server), the default export of `intl/request.ts`, and its options' type `RequestConfigOptions`.                                                                                                                           |
| `/start`                | `useLocaleSwitch(persist)`, `loadIntlConfig`, `createCatalogReload(import.meta.hot)` (dev: a PO save reruns the loaders).                                                                                                                                                                                   |
| `/effect`               | `CurrentIntl`, the translator as an Effect service: `const { t } = yield* CurrentIntl`, provided per request by `CurrentIntl.provide(options)` or for a whole program by `CurrentIntl.layer(options)` (see "Effect" below). Needs the optional peer `effect` (`^4.1.3`).                                    |

`negotiateLocale(header, locales, { aliases })` (`/core`) picks the most preferred of `locales` an Accept-Language
header accepts (RFC 9110 §12.4.2 weights, RFC 4647 §3.4 lookup, so `nb-NO` finds `nb`), written as in `locales`, or
`undefined` when it accepts none, so the app's default answers. The wildcard names no locale: `*` alone gives
`undefined`, the app's default, and `*, sv;q=0.5` gives `sv`. A range rejected with `q=0` excludes the locale it names
on every path, and its alias target only through an alias: with `{ no: "nb", nn: "nb" }` and no `no` shipped,
`nb-NO, nb;q=0` and `nn, no;q=0` are not Bokmål, but `nb, no;q=0` is, since an alias is the app's mapping and never
takes away a locale the client names. It throws a `RangeError` when the configuration is wrong (an alias naming a
locale not in the list, two locales differing only in case), on every call, whatever the header.

`<IntlProvider locale catalog timeZone formats>` takes the serializable config, so a Next layout or a Start root loader passes it straight through. The catalog is the request locale's compiled catalog (type `Catalog`, which only the compiler makes, so a PO or a JSON of translations does not type-check): complete, with an untranslated message as its English source, formatted in `en`. A message the catalog lacks renders its source as is when it is plain text; a structured one (not extracted yet: in dev until the watcher writes the PO, about a second) renders its raw source, or `<T>`'s children, and calls `onError` with `MessageNotExtracted`. A message that fails to format (a missing or wrongly typed value: a caller bug the types and `check` rule out) calls `onError`; then `t` throws, and `<T>` renders its children. The two differ because `<T>` has what the developer wrote to render, while `t`'s only fallback would be the ICU source (`Hi {name}`), which is syntax, not text. Every date and time formats in `timeZone`. `t` and `t.from` always return text, and never call a function value (only `<T>` renders tags). Argument values are typed as next-intl types them: a plain `{x}` (and `<Val>`) takes text only, a number goes through `{x, number}`, `plural` or `selectordinal`, a `Date` through `{x, date}` or `{x, time}`, a select takes text. `t.from` types values from its descriptor's literal; a descriptor widened to `Descriptor` takes untyped values. A number or `Date` that reaches a plain `{x}` untyped (a cast or `any`) fails like a missing argument (`onError`; then `t` throws, and `<T>` renders its children), naming the argument and the fix. A present `null` or `undefined` in `t`'s values, or as a `<Val>`'s value, renders as nothing in a plain `{x}`, as in next-intl. A translation that reads that argument as a `select` renders the branch `t` picks for the same value, from `t` and `<Val>` alike.

With no `onError`, a report goes to `console.error` as `@elmeragroup/intl: "<key>" <error>`, once per distinct problem (its key and message) in a loaded copy of the runtime (past 1,000 distinct problems its record clears, so one may log again), in development and production alike: the browser's console, or the server's stderr. An `onError` receives every report instead, and nothing is logged: pass it to `createIntl`, `<IntlProvider>`, `CurrentIntl.layer` or `CurrentIntl.provide`'s options, or, for the server translator on Next, as `createRequestConfig(adapter, { onError })`. A Next server layout cannot pass a function to the client provider, so a Next app gives its client provider an `onError` from a `"use client"` component that renders `<IntlProvider>` with it.

`formats` is next-intl's global `formats`, with its shape and meaning: `{ dateTime: { short: { year: "numeric", month: "short", day: "numeric" } }, number: { … } }` changes what `{d, date, short}` (and `{d, time, short}`) renders. A style named like a built-in one (`short`, `medium`, `long`, `full`; `integer`, `currency`, `percent`) merges over it key by key; a date or time style formats in `timeZone` unless it sets its own. A message naming a style that is neither built in nor configured renders the kind's default format, as in next-intl, and `check` accepts it. `check` and the loaders dry-format every message with the formats module `elmera-intl.json` names (tools README, "CLI"), the module the adapter imports too. The client provider needs `formats` too: pass it to `<IntlProvider>` with the rest of the config. `formatAst` keys its formatters by formats, so instances with different formats never share one.

`format` (`intl.format`, `useFormat()`, `getFormat()`) is next-intl's `useFormatter()` / `getFormatter()`: the same methods, overloads, output and fallbacks (`dateTime`, `dateTimeRange`, `number`, `relativeTime`, `list`), over the same process-wide `Intl` caches messages use. Dates and ranges format in `timeZone` unless the options set their own. A name (`format.dateTime(d, "long")`) is looked up in `formats` only, with no built-in styles (`"medium"` is missing unless configured), as next-intl does; options passed beside it override the named format's. `formats.list` holds named list styles. A missing name or options `Intl` rejects call `onError` (or, with none, the default above) with the method as the key (`format.number`) and render next-intl's fallback (`String(value)`). Two departures: `relativeTime` takes `now` explicitly (`relativeTime(date, now)` or `{ now, unit, style, numberingSystem }`), with no config `now` and no clock read, so server and client render the same phrase from the same `now`; and `list` takes text only (no React elements). `displayName` is not ported.

Keys: whitespace runs collapse and ends trim; elements become positional tags (`<x0>`), so `<a>` -> `<Link>` never re-keys; literal ICU syntax is quoted. The PO is keyed by that source and context, for people; a compiled catalog by `hashKey` of the key, seven base-36 characters, which the runtime computes per call (memoized per string). A serializer or hash change bumps `SERIALIZER_VERSION`, and `check` fails on catalogs keyed by another version.

## Adapter interface

```ts
type ServerAdapter = {
  resolveLocale(request: { headers: { get(name: string): string | null } }): string | Promise<string>;
  loadCatalog(locale: string): Promise<Catalog>; // e.g. import("./intl/nb.po"), import("./intl/nb.po?source") for en
  resolveTimeZone(request: { headers: { get(name: string): string | null } }): string | Promise<string>;
  formats?: Formats; // the same for every request
};
```

The client side is `persist(locale)` (the app's, e.g. a server action setting a cookie; it may return a promise or nothing, and may be a new function each render, since a switch, queued or held, calls the one its mount last committed under the router that admitted the switch, when it starts, even after that mount unmounted or moved to another router; on Next it reads `persist` and the `refresh` option from the same commit) plus the framework's refresh (Next `router.refresh()`, Start `router.invalidate({ sync: true })`). A switch persists, then refreshes, so the provider gets the new `{ locale, catalog }` in the same commit as the rest of the server data. Latest switch wins: switches run one at a time in call order and a switch superseded before it persisted or refreshed skips that step. A switch resolves `Superseded` when a later switch started before it ended, whichever way it ended, so only the latest switch reports `Switched`, `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order. A caller that starts switches from user events (the example apps) can therefore show every outcome that is not `Superseded` as it arrives: its handlers run before the next event can start a switch. A caller that starts a switch from a promise callback can see an older switch's outcome delivered after the newer one started, and needs its own latest-attempt check if its status must reflect the latest choice at display time. With Start, whose `invalidate({ sync: true })` resolves once the new data is rendered (without `sync` it resolves at once while the loader reloads in the background), an older refresh always lands before a newer one; Next's `router.refresh()` resolves on dispatch, so render order across overlapping refreshes is Next's router's.

One switch queue serves each router, shared by every mount of `useLocaleSwitch` under it, so any number of switchers may mount, on any page, and a switch held in a switcher that unmounted still yields to a newer one from the next. The queue's identity is the router's: on Next, one queue per `router.refresh` function, which is Next's own navigator, so every App Router in a page shares it; on Start, one queue per router object. `isPending` is router-wide for switches: a client-rendered switcher mounted while another's switch is held shows it from its first commit; a hydrating one renders the server's `false` in its hydration commit and shows the switch from the commit after. A switch counts until it settles. On Start that is once the reloaded data rendered. On Next in `"router-refresh"` mode it is when its refresh is dispatched, and the render after that shows only in the dispatching switcher's `isPending`; in `"server-action"` mode the action's render shows in the dispatching switcher's transition. So after a remount on Next, no switcher shows the old mount's render landing. Mounts with different Next refresh modes share the queue. `createLocaleSwitcher` (`/core`) makes a queue of its own per call.

- Next: `intl/request.ts` default-exports `createRequestConfig(adapter)` (from `/next/server`; `createRequestConfig(adapter, { onError })` gives the server translator its `onError`), and `withIntl` aliases the runtime's request config to it, so no page, layout, action or route imports setup code (another path goes in withIntl's `request` option; restart `next dev` after creating the file, since `withIntl` looks for it when next.config loads). The adapter gets the request's headers with `cookie` written from `cookies()`, so inside a server action that set the locale cookie it already sees the new locale. `cookies()` is Next's own store, built from the request's headers on the first `cookies()` read and cached apart from a route handler's `request.cookies` after that: a rewrite of the incoming request's cookies (`request.cookies.set(...)`) made before anything in the request reads `cookies()` is seen by `getIntl()`, but a rewrite made after Next has initialized its store (a `cookies()` read, `getIntl()` included, came first) is not. For that case, build the config from the request it rewrote, with `createIntl(await resolveIntlConfig(adapter, request))`, rather than `getIntl()`, which would see the old locale; this works only for an adapter that reads the passed request's `cookie` header (`request.headers.get("cookie")`). An adapter that reads `cookies()` itself, as the Next example's does, still sees Next's store, so the workaround does not apply there. The layout reads `const { locale, catalog, timeZone, formats } = await getIntl()` and renders `<IntlProvider locale={locale} catalog={catalog} timeZone={timeZone} formats={formats}>`; a client component calls `useLocaleSwitch(setLocaleAction)`. When the persist is a Server Action that sets the cookie (Next re-renders the page and layouts in the action's own response), pass `{ refresh: "server-action" }` to skip the redundant `router.refresh()` roundtrip.
- Start: a root-route loader calls a server function that returns `loadIntlConfig(adapter, getRequest())`; the root component renders `<IntlProvider>` from the loader data, and `const CatalogReload = createCatalogReload(import.meta.hot)` (at the root route module's top level) rendered once; a component calls `useLocaleSwitch(setLocaleFn)`.

## Effect

`@elmeragroup/intl/effect` serves the translator to Effect programs: an HTTP server on `effect/http`, a queue worker, a
CLI. Install `effect` (`^4.1.3`, an optional peer) beside the package; no other subpath imports it.

`CurrentIntl` is a `Context.Service` whose value is the `IntlInstance` `createIntl` builds, so `t` is typed from its
literal and the extractor reads it like any other: `const { t } = yield* CurrentIntl`, `(yield* CurrentIntl).t("…")`,
`intl.t.from(d)`. Any other read of `CurrentIntl` (`.use`, `Effect.map(CurrentIntl, …)`, an alias) fails extraction.

The app resolves the options, as an `Effect<CreateIntlOptions, E, R>` with its own errors and requirements (the request,
a config service), and loads its compiled catalogs its own way. Per request, `CurrentIntl.provide(options)` resolves them
each time the wrapped effect runs, so no translator outlives its request; it is never a layer, because `Effect.provide`
reuses a layer an enclosing runtime already built. On `effect/http` it goes in a global `HttpRouter.middleware`:

```ts
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import type { Catalog } from "@elmeragroup/intl/core";
import { negotiateLocale } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";

const LOCALES = ["en", "nb"] as const;

// App-owned: compiled catalogs, loaded the app's way (here, `*.po` imports through the Vite plugin).
const loadCatalog = (locale: "en" | "nb"): Effect.Effect<Catalog> =>
  Effect.promise(() => (locale === "nb" ? import("./intl/nb.po") : import("./intl/nb.po?source"))).pipe(
    Effect.map((module) => module.default)
  );

const intlOptions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // App policy: a stored choice, else the best of Accept-Language (Norwegian and Nynorsk as Bokmål), else English.
  const stored = LOCALES.find((locale) => locale === request.cookies.locale);
  const locale =
    stored ??
    negotiateLocale(request.headers["accept-language"], LOCALES, { aliases: { no: "nb", nn: "nb" } }) ??
    "en";

  return { locale, catalog: yield* loadCatalog(locale), timeZone: "Europe/Oslo" };
});

const IntlMiddleware = HttpRouter.middleware<{ provides: CurrentIntl }>()(
  (handler) => handler.pipe(CurrentIntl.provide(intlOptions)),
  { global: true }
);

const greet = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;

  return HttpServerResponse.text(t("Hello, {name}", { name: "Ada" }));
});

const { handler, dispose } = HttpRouter.toWebHandler(
  HttpRouter.add("GET", "/", greet).pipe(Layer.provide(IntlMiddleware))
);
```

`negotiateLocale` is the `/core` function described below the subpath table; it is platform-neutral, so a Next adapter or
a Start server function calls it the same way.

The effect `CurrentIntl.provide` returns fails with the handler's errors and the options effect's, and requires every
service the options effect uses plus what the handler still requires once `CurrentIntl` is provided. In the loader above a rejected import is a defect, since
`Effect.promise` declares no failure; to make a catalog that cannot load recoverable, load it with `Effect.tryPromise`
and map the rejection to the app's own error. A catalog compiled for another catalog version throws in `createIntl`, so
it is a defect, as on every host.

A program with one locale (a worker, a CLI, a test) provides a fixed translator once:
`program.pipe(Effect.provide(CurrentIntl.layer({ locale: "nb", catalog, timeZone: "Europe/Oslo" })))`.
