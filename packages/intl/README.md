# @elmeragroup/intl

Source-keyed i18n for React. Code is written in English, as hooks or JSX; a message is identified by its English source plus an optional context, and looked up by a short hash of that key in the locale's compiled catalog. The runtime has no ICU parser: it formats only compiled catalogs. Locale switches in place.

Extraction, PO catalogs, the catalog compiler and its loaders, the `elmera-intl` CLI, lint and the Vitest catalog check live in [`@elmeragroup/intl-tools`](../intl-tools/README.md): its deny-by-default extractor writes the POs, the host compiles a `*.po` import into a catalog, and `check` proves them in sync and compilable. Apps depend on this package and take the tools as a devDependency.

## Setup

Three touches per app:

1. `elmera-intl.json` beside the app's package.json (see the tools README's CLI section).
2. The host integration from `@elmeragroup/intl-tools`: Vite `intl()`, or Next `withIntl(config, { dir: import.meta.dirname })` with `elmera-intl check && next build` and `elmera-intl extract --watch` beside `next dev` (tools README, "Hosts"), and the server adapter's `loadCatalog` importing the locale's PO (`./intl/nb.po`, `./intl/nb.po?source` for `en`).
3. `<IntlProvider>` in the root layout (Next) or root route (Start), and `useLocaleSwitch(persist)` where the language is chosen (see "Adapter interface" below).

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
| `/core`                 | `createIntl`, `msg`, `keyOf`, `serialize`, `SERIALIZER_VERSION`, `createLocaleSwitcher`, `resolveIntlConfig`, types (`IntlInstance`, `Translate`, `Descriptor`, `Catalog`, `Formats`, `IntlConfig`, `ServerAdapter`, `RequestConfig`, `SwitchOutcome`). No React.                                           |
| `/react`                | `IntlProvider`, `useIntl`, `T`, `Val`, `Plural`, `Select`, `useT`, `useFormat`, `msg`, `createIntl`. Same list under `default` and `react-server`; the `react-server` build reads the request's `IntlInstance` (`React.cache`), and its `IntlProvider` is the client one, so a server layout can render it. |
| `/server`               | `getIntl`, `getT`, `getFormat`, read from the host's request config (Next: `withIntl` aliases it to the app's `intl/request.ts`).                                                                                                                                                                           |
| `/next`, `/next/server` | `useLocaleSwitch(persist)` (client); `createRequestConfig(adapter)` (server), the default export of `intl/request.ts`.                                                                                                                                                                                      |
| `/start`                | `useLocaleSwitch(persist)`, `loadIntlConfig`, `createCatalogReload(import.meta.hot)` (dev: a PO save reruns the loaders).                                                                                                                                                                                   |
| `/effect`               | `CurrentIntl`, the translator as an Effect service: `const { t } = yield* CurrentIntl`, provided per request by `CurrentIntl.provide(options)` or for a whole program by `CurrentIntl.layer(options)` (see "Effect" below). Needs the optional peer `effect` (`^4.1.3`).                                    |

`<IntlProvider locale catalog timeZone formats>` takes the serializable config, so a Next layout or a Start root loader passes it straight through. The catalog is the request locale's compiled catalog (type `Catalog`, which only the compiler makes, so a PO or a JSON of translations does not type-check): complete, with an untranslated message as its English source, formatted in `en`. A message the catalog lacks renders its source as is when it is plain text; a structured one (not extracted yet: in dev until the watcher writes the PO, about a second) renders its raw source, or `<T>`'s children, and calls `onError` with `MessageNotExtracted`. A message that fails to format (a missing or wrongly typed value: a caller bug the types and `check` rule out) calls `onError`, then throws. Every date and time formats in `timeZone`. `t` and `t.from` always return text, and never call a function value (only `<T>` renders tags). Argument values are typed as next-intl types them: a plain `{x}` (and `<Val>`) takes text only, a number goes through `{x, number}`, `plural` or `selectordinal`, a `Date` through `{x, date}` or `{x, time}`, a select takes text. `t.from` types values from its descriptor's literal; a descriptor widened to `Descriptor` takes untyped values. A number or `Date` that reaches a plain `{x}` untyped (a cast or `any`) fails like a missing argument (`onError`, then a throw), naming the argument and the fix. A present `null` or `undefined` renders as nothing, as in next-intl.

`formats` is next-intl's global `formats`, with its shape and meaning: `{ dateTime: { short: { year: "numeric", month: "short", day: "numeric" } }, number: { … } }` changes what `{d, date, short}` (and `{d, time, short}`) renders. A style named like a built-in one (`short`, `medium`, `long`, `full`; `integer`, `currency`, `percent`) merges over it key by key; a date or time style formats in `timeZone` unless it sets its own. A message naming a style that is neither built in nor configured renders the kind's default format, as in next-intl, and `check` accepts it. `check` and the loaders dry-format every message with the formats module `elmera-intl.json` names (tools README, "CLI"), the module the adapter imports too. The client provider needs `formats` too: pass it to `<IntlProvider>` with the rest of the config. `formatAst` keys its formatters by formats, so instances with different formats never share one.

`format` (`intl.format`, `useFormat()`, `getFormat()`) is next-intl's `useFormatter()` / `getFormatter()`: the same methods, overloads, output and fallbacks (`dateTime`, `dateTimeRange`, `number`, `relativeTime`, `list`), over the same process-wide `Intl` caches messages use. Dates and ranges format in `timeZone` unless the options set their own. A name (`format.dateTime(d, "long")`) is looked up in `formats` only, with no built-in styles (`"medium"` is missing unless configured), as next-intl does; options passed beside it override the named format's. `formats.list` holds named list styles. A missing name or options `Intl` rejects call `onError` with the method as the key (`format.number`) and render next-intl's fallback (`String(value)`). Two departures: `relativeTime` takes `now` explicitly (`relativeTime(date, now)` or `{ now, unit, style, numberingSystem }`), with no config `now` and no clock read, so server and client render the same phrase from the same `now`; and `list` takes text only (no React elements). `displayName` is not ported.

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

The client side is `persist(locale)` (the app's, e.g. a server action setting a cookie; it may return a promise or nothing, and may be a new function each render, since a switch calls the latest committed one) plus the framework's refresh (Next `router.refresh()`, Start `router.invalidate({ sync: true })`). A switch persists, then refreshes, so the provider gets the new `{ locale, catalog }` in the same commit as the rest of the server data. Latest switch wins: switches run one at a time in call order and a switch superseded before it persisted or refreshed skips that step. A switch resolves `Superseded` when a later switch started before it ended, whichever way it ended, so only the latest switch reports `Switched`, `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order. A caller that starts switches from user events (the example apps) can therefore show every outcome that is not `Superseded` as it arrives: its handlers run before the next event can start a switch. A caller that starts a switch from a promise callback can see an older switch's outcome delivered after the newer one started, and needs its own latest-attempt check if its status must reflect the latest choice at display time. With Start, whose `invalidate({ sync: true })` resolves once the new data is rendered (without `sync` it resolves at once while the loader reloads in the background), an older refresh always lands before a newer one; Next's `router.refresh()` resolves on dispatch, so render order across overlapping refreshes is Next's router's.

- Next: `intl/request.ts` default-exports `createRequestConfig(adapter)` (from `/next/server`), and `withIntl` aliases the runtime's request config to it, so no page, layout, action or route imports setup code (another path goes in withIntl's `request` option; restart `next dev` after creating the file, since `withIntl` looks for it when next.config loads). The adapter gets the request's headers with `cookie` written from `cookies()`, so inside a server action that set the locale cookie it already sees the new locale. `cookies()` is Next's own store, built from the request's headers on the first `cookies()` read and cached apart from a route handler's `request.cookies` after that: a rewrite of the incoming request's cookies (`request.cookies.set(...)`) made before anything in the request reads `cookies()` is seen by `getIntl()`, but a rewrite made after Next has initialized its store (a `cookies()` read, `getIntl()` included, came first) is not. For that case, build the config from the request it rewrote, with `createIntl(await resolveIntlConfig(adapter, request))`, rather than `getIntl()`, which would see the old locale; this works only for an adapter that reads the passed request's `cookie` header (`request.headers.get("cookie")`). An adapter that reads `cookies()` itself, as the Next example's does, still sees Next's store, so the workaround does not apply there. The layout reads `const { locale, catalog, timeZone, formats } = await getIntl()` and renders `<IntlProvider locale={locale} catalog={catalog} timeZone={timeZone} formats={formats}>`; a client component calls `useLocaleSwitch(setLocaleAction)`. When the persist is a Server Action that sets the cookie (Next re-renders the page and layouts in the action's own response), pass `{ refresh: "server-action" }` to skip the redundant `router.refresh()` roundtrip.
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
import { CurrentIntl } from "@elmeragroup/intl/effect";

// App-owned: compiled catalogs, loaded the app's way (here, `*.po` imports through the Vite plugin).
const loadCatalog = (locale: "en" | "nb"): Effect.Effect<Catalog> =>
  Effect.promise(() => (locale === "nb" ? import("./intl/nb.po") : import("./intl/nb.po?source"))).pipe(
    Effect.map((module) => module.default)
  );

const intlOptions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const locale = request.cookies.locale === "nb" ? "nb" : "en";

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

The effect `CurrentIntl.provide` returns fails with the handler's errors and the options effect's, and requires every
service the options effect uses plus what the handler still requires once `CurrentIntl` is provided. In the loader above a rejected import is a defect, since
`Effect.promise` declares no failure; to make a catalog that cannot load recoverable, load it with `Effect.tryPromise`
and map the rejection to the app's own error. A catalog compiled for another catalog version throws in `createIntl`, so
it is a defect, as on every host.

A program with one locale (a worker, a CLI, a test) provides a fixed translator once:
`program.pipe(Effect.provide(CurrentIntl.layer({ locale: "nb", catalog, timeZone: "Europe/Oslo" })))`.
