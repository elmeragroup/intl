# @elmeragroup/intl

## 0.1.0

### Minor Changes

- d9163e8: `@elmeragroup/intl/effect`: `CurrentIntl`, the translator as an Effect service (`const { t } = yield* CurrentIntl`), provided per request by `CurrentIntl.provide(options)` or once by `CurrentIntl.layer(options)`, with `effect` (`^4.1.3`) as an optional peer. The extractor and the `elmera-intl/extractable` lint rule read `yield* CurrentIntl` as a bound IntlInstance and reject any other read of the service.
- c687582: First public release: the source-keyed runtime with its Next.js and TanStack Start adapters, and the build-time tools (extractor, `elmera-intl` CLI, PO catalogs, compiler and loaders, Vite and Next plugins, the `elmera-intl/extractable` lint rule and the Vitest catalog check).
- 2999867: A report with no `onError` now reaches `console.error`, where it was dropped: a message not extracted yet, a message
  that fails to format, a failed `format` call, or a `<T>` inside a `<T>` logs `@elmeragroup/intl: "<key>" <error>`,
  once per distinct problem in a loaded copy of the runtime (past 1,000 distinct problems the record clears, so one may log again). This holds in production too, in the browser's console and
  on the server's stderr, so an app with no `onError` now shows these lines to its users and in its server logs. What
  renders and what throws are unchanged. To silence or route the reports, pass `onError` to `createIntl`,
  `<IntlProvider>` (on Next, from a `"use client"` component that renders it), or `CurrentIntl.layer`/`CurrentIntl.provide`'s
  options; an `onError` receives every report, as before, and nothing is logged. The server translator on Next takes its
  handler from the request module, with the new second argument: `createRequestConfig(adapter, { onError })` (its options'
  type, `RequestConfigOptions`, is exported from `@elmeragroup/intl/next/server`), and a hand-written `RequestConfig` may
  return `onError` with the config.
- 351f3a2: `@elmeragroup/intl/core`: `negotiateLocale(acceptLanguage, locales, { aliases })`, the most preferred of an app's locales an Accept-Language header accepts (RFC 9110 §12.4.2 weights, RFC 4647 §3.4 lookup), written as in `locales`, or `undefined` for the app's default, with the `NegotiateLocaleOptions` type. Aliases (`{ no: "nb", nn: "nb" }`) are case-insensitive and checked along the lookup chain after the locales themselves. A range rejected with `q=0` excludes the locale it names on every path and its alias target only through an alias, so `nb-NO, nb;q=0` and, with those aliases and no `no` shipped, `nn, no;q=0` are not Bokmål, but `nb, no;q=0` is; `*` is the caller's default at any weight. A wrong configuration (an alias naming a locale not in the list, an alias that is not a concrete language range, two locales differing only in case) throws a `RangeError` on every call. The example apps negotiate with it in place of their own copies.
- 2551a6e: Next.js apps no longer import setup code in every page, layout and server action. `withIntl` now adds a Turbopack alias from the runtime's request config to the app's request module, `intl/request.ts` (or the new `request` option), whose default export is `createRequestConfig(adapter)` from `@elmeragroup/intl/next/server`; route handlers and server actions read the request's locale with no import. Drop `"sideEffects": true` and the `intl/configure` imports.

  - Removed: `configureRequestIntl` (`/server`) and `configureNextIntl` (`/next/server`).
  - Added: `createRequestConfig` (`/next/server`), the `RequestConfig` type (`/core`, `/next/server`), and `withIntl`'s `request` option and alias. Only the runtime's `react-server` request config imports the aliased specifier, so Client Component code (SSR and browser) gets the runtime's stub, which names the cause, and never the app's adapter. `withIntl` fails when a `turbopack.resolveAlias` key, exact or a wildcard whose pattern matches, already maps the runtime's request module: anything but an exact key to withIntl's own target, or any key when withIntl aliases none.
  - Fixed (#20): inside a server action, the adapter now sees the locale cookie the action set, so the page Next re-renders in the action's response is in the new locale. The adapter's `cookie` header is written from `cookies()`.

- 66bed00: The peer ranges are now the versions CI tests, each with a ceiling at its tested major:

  - `@elmeragroup/intl-tools` takes `vite` `^8.2.0` (was `>=6.0.0`), the lowest Vite the tools' tests pass on (#96 tracks widening it). Vite 6 and 7 are outside it because CI cannot run the tools' tests on them (part of the harness is written for Rolldown). Below 8.2 the known defects are a build watch's: on 8.0 it misses rebuilds (after a source edit it does not check the catalogs again, and it does not recover once a missing PO or catalog directory is created), on 8.1 one that should stay idle after a missing config is created reports extra changes to the project directory; and the plugin's own under a symlinked project root (macOS's `/var` temp directories), 8.1 included: its catalog paths and watch filtering come out through the link (`../../…/private/var/…/messages/sv.po is not a configured catalog`), so its errors and watch go wrong (#96). Upgrade Vite to `^8.2.0`.
  - `next` is `^16.4.0` in both packages (was `>=16.4.0`), and `@tanstack/react-router` is `^1.170.0` in `@elmeragroup/intl` (was `>=1.170.0`), so a new major is outside the range until it is tested. With `@elmeragroup/intl/start`, keep `@tanstack/react-start` and the router it pins aligned, since each react-start release depends on one exact router version; the tested floor pair is react-start 1.168.0 with router 1.170.0.
  - `@elmeragroup/intl-tools` declares `vitest` `^5.0.0` as an optional peer, for its `/vitest` global setup and the module-cache hook of `intlCatalogs()`. The hook no longer falls back to Vitest 4's `experimental_defineCacheKeyGenerator`. On Vitest 3 and 4 it registers nothing, so a run does not fail there, but on Vitest 4 with its experimental module cache turned on (`experimental.fsModuleCache`), a run after an edit of `elmera-intl.json` or of its formats module can reuse the old compiled catalog. Upgrade Vitest to 5 (#97 tracks Vitest 4.1). Both Vite and Vitest are optional peers, so an app that uses only `/next` need not install either, but an installed one outside its range, also one another package brings in (Vitest 4, or a Vite below 8.2), is a peer conflict, which npm can refuse (`ERESOLVE`, for example when the app pins that version itself), and pnpm reports as a warning, or as an error with `strictPeerDependencies`.

  `react` (`^19.0.0`) and `effect` (`^4.1.3`) are unchanged.

### Patch Changes

- d9163e8: The PO reader and writer are now `@elmeragroup/intl-tools`' own Effect `Schema` codec, replacing the `po-parser` dependency with `effect` (4.1.3). Catalogs read and write as before: the same GNU msgcat reading, held by po-parser 2.2.0's ported test suite and its recorded output (`test/po-conformance`).
- 354e411: A plural message no longer throws a `TypeError` on an engine without `Array.prototype.toSorted` (ES2023), and keys
  as before. The runtime's own source now calls no built-in later than ES2022, its build target, and its type-check and
  lint hold it there; the README's "Engines" section states that floor and what neither gate covers.
- ff43d8f: `LocaleSwitch` from `/next` and `/start` is now declared as a mapped type over one shared shape. The type is
  equivalent, so a package that exports an inferred wrapper of `useLocaleSwitch` needs no change: its declarations still
  name `import("@elmeragroup/intl/next").LocaleSwitch` or `import("@elmeragroup/intl/start").LocaleSwitch` (#60).
- 3626d2a: A `<T>` containing another `<T>` (the same loaded `T` function, at any depth) now reports to `onError` and renders
  its children as written, the inner `<T>` translating itself, where it used to render a wrong translation silently
  whenever the catalog had the outer message's key; keep the whole text in the outer `<T>`. The runtime does not catch
  a wrapper component that renders a `<T>` (which extraction misses too), a second loaded copy of the package, or, in a
  Next server component, a client-reference `<T>`, which it reads as a tag. A server component reports to the request
  config's `onError` (`createRequestConfig(adapter, { onError })`), or to `console.error` with none (#100).
- b6fa2bf: `react` is now an optional peer, so an app that uses only `/core` or `/effect` (an Effect server, for example) no longer gets React installed by npm, or a missing-peer warning (an error with `strictPeerDependencies`) from pnpm with `autoInstallPeers: false`. Every subpath that renders still needs it: install `react` `^19.0.0` with `/react`, `/server`, `/next`, `/next/server` or `/start` (#113).
- fd9b03f: `<T>` no longer throws where it can render what the developer wrote. It reports once (to `onError`, or the default
  `console.error`) and renders its children untranslated in each of these cases (#99):

  - A `<Val>`, `<Plural>` or `<Select>` the extractor rejects: zero or two value props, a `<Plural>` form or `<Select>`
    branch that is not a string, a `<Select>` branch name that is no select key (`_a-b`, `_other`), or a `<Select>`
    without `other`. The report carries the message the throw had.
  - A value that is neither text nor a number from an untyped caller (`any`, a cast), such as an object, a `Date`, a
    boolean, or a `null` `<Plural>` count or `<Select>` value. It is reported as `<Val v> needs a string or number value`
    (or `<Plural n>`, `<Select k>`) under the message's key.
  - A message that fails to format, such as a number in a plain `{n}` (`PlainArgumentNotText`). `t` and `t.from` still
    report and then throw the formatter's own error, since their only fallback would be the ICU source.

  A `<Val>` whose value is a present `null` or `undefined` now formats as `t()` formats the same value: a plain `{v}`
  renders nothing, and a translation that reads it as a select gets the same branch. It threw a `TypeError` before. A
  child that is neither text nor an element (a promise, an object) still throws, since `<T>` cannot put it in a message.
  An `onError` that throws still propagates out of `<T>`.

  `Val`, `Plural` and `Select` outside a `<T>` (which is what the fallback renders) now render only text the developer
  wrote, or nothing. This changes what an app sees if it renders them outside a `<T>`:

  - `Val`: `null`, `undefined`, an object, a `Date` and `true` rendered "null", "undefined", "[object Object]", the date
    in the host's time zone, and "true". They now render nothing. A string or a number renders as before. `children` no
    longer renders: `<Val v="a">b</Val>` rendered "ab" and now renders "a".
  - `Select`: `_other="A"` with the value `other`, or `_a-b="A"` with the value `a-b`, rendered "A" and now renders
    `other`.
  - `Select`: a matched branch that is not a string, such as `_a={1}` or `_a={<b>A</b>}`, rendered "1" or the element,
    and now renders `other`. An object branch or an object `other` crashed React, and now renders `other`, or nothing
    when `other` is not a string.
  - `Plural`: a form that is not a string counts as unwritten, so `n={1} one={1} other="# xs"` rendered nothing and now
    renders "1 xs".

- 5c344c9: - `useLocaleSwitch` (`/next`, `/start`) and `createLocaleSwitcher` (`/core`): a switch resolves `Superseded` whenever a later switch started before it ended, however it ended, so only the latest switch reports `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order. A caller that starts switches from user events can show every outcome that is not `Superseded` without tracking attempts itself; one that starts a switch from a promise callback can see an older switch's outcome delivered after the newer one started, and needs its own latest-attempt check if its status must reflect the latest choice at display time. When the latest switch's persist fails after a refresh failed, it now re-renders the locale the server stored.
  - `withIntl` (`/next`) accepts a config written `{ … } satisfies NextConfig` that sets neither `turbopack` nor `outputFileTracingRoot`, and returns the config's own type, so the result assigns to `NextConfig` and passes to another plugin. It rejects a config it cannot spread, as the config or as `turbopack`: a function, a thenable or an array in its types, and at runtime (a `next.config.mjs`, a wrapper generic over `NextConfig`) a thenable, plain or not (whatever its `then` is tagged), and anything but a plain object from any realm (a null prototype, or a realm's own `Object.prototype`), a class instance or an object inheriting its settings included, with an error naming what it got and, for a phase function, to call `withIntl` inside it with Next's both arguments: `export default async (phase, context) => withIntl(await config(phase, context), options)`.
- 9b1123f: - `useLocaleSwitch` (`/next`, `/start`) keeps one switch queue per router, shared by every mount under it, as its documentation said: a switcher may mount anywhere and any number of times, and a switch held in a switcher that unmounted still yields to a newer one from the next, so the latest switch wins across remounts. On Next the queue belongs to `router.refresh` (Next's own navigator, so every App Router in a page shares it); on Start, to the router object. `isPending` is router-wide for switches: a client-rendered switcher mounted while another's switch is held shows it from its first commit (a hydrating one, from the commit after), and server renders show `false`. Each switch calls the `persist` its mount last committed under the router that admitted it, when the switch starts, published as the commit lands (before its layout effects, and also inside a hidden `<Activity>`), so a switch released from any effect of the commit that changed it calls the new one; a switch queued before its mount moved to another router persists and refreshes through the router that admitted it. On Next a switch reads `persist` and the `refresh` option from the same commit, so a mount that changed mode while a switch was queued refreshes when its new persist needs it. A mounted switcher keeps only what it committed under its current router, and what a queued switch still needs. A `router.refresh()` that throws now resolves the switch `RefreshFailed` (it resolved `Switched` and threw in the switcher's next render), and one that throws during a failed persist's recovery counts as a failed refresh, so the next failed persist still re-renders the stored locale. Mounts with different Next refresh modes share the queue: when a `"server-action"` switch's persist fails after a `"router-refresh"` switch stored a locale it never rendered, the failing switch's own refresh renders it. An app that lifted the hook into one shared provider to get one queue can call it in each switcher instead.
  - `createLocaleSwitcher` (`/core`) is unchanged: each call makes its own queue, and calls the port's methods on the port.
