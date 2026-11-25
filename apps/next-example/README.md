# Next.js example

`@elmeragroup/intl` and `@elmeragroup/intl-tools` in a Next.js App Router app, in English (the
source language), Norwegian Bokmål, Swedish and Finnish. The app is a power retailer's back office
built on Elmera's [Fuse](https://github.com/elmeragroup/fuse) design system: Fuse's app-shell block
(sidebar, header, command menu, overview, invoices, metering points and settings) with every string
translated, and the packages' features a Next app uses placed where such an app would use them (the
few left out are listed below).

The block's source is Fuse's docs app at commit
[`9be80460091e90854ec169986b4be7411d2e592f`](https://github.com/elmeragroup/fuse/tree/9be80460091e90854ec169986b4be7411d2e592f/apps/docs/src/app/%28docs%29/blocks/app-shell/demos)
(`apps/docs/src/app/(docs)/blocks/app-shell/demos` and its preview routes), the commit
`@elmeragroup/fuse@0.1.0-canary.208` was built from. Fuse is MIT-licensed, © Elmera Group; each
ported file names the block file it came from.

From the repository root, through turbo, which builds the packages the app links first (a fresh
checkout has no `dist`):

```sh
pnpm turbo run dev --filter=@elmeragroup/next-example   # next dev on :3030, with elmera-intl extract --watch
pnpm --filter @elmeragroup/next-example exec playwright install chromium webkit   # once: the browsers the specs run in
pnpm turbo run test:run --filter=@elmeragroup/next-example   # check the catalogs, then the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/next-example   # check, build, then the Playwright specs
```

## Where each feature lives

| Feature                                                                                                                                                                            | File                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build plugin: `withIntl` compiles `*.po` imports and aliases `intl/request.ts`                                                                                                     | [next.config.ts](next.config.ts)                                                                                                                 |
| CLI config: sources, catalogs, locales, formats                                                                                                                                    | [elmera-intl.json](elmera-intl.json)                                                                                                             |
| CLI scripts: `check` before `build`, `extract --watch` beside `dev`                                                                                                                | [package.json](package.json)                                                                                                                     |
| Catalogs: the POs translators edit; typed `*.po` imports                                                                                                                           | [intl/nb.po](intl/nb.po), [intl/sv.po](intl/sv.po), [intl/fi.po](intl/fi.po), [intl/catalogs.d.ts](intl/catalogs.d.ts)                           |
| `#, ignore-same`: a translation that is the English on purpose (placeholders, units)                                                                                               | [intl/nb.po](intl/nb.po), [intl/sv.po](intl/sv.po), [intl/fi.po](intl/fi.po)                                                                     |
| Named formats, shared by the runtime and `check`: a date, a time, kroner, a change, a spot price                                                                                   | [intl/formats.ts](intl/formats.ts)                                                                                                               |
| Server adapter: locale from `cookies()`, the four catalogs, the market's time zone                                                                                                 | [intl/adapter.ts](intl/adapter.ts)                                                                                                               |
| Request config: `createRequestConfig(adapter)`, read by `getIntl` with no import                                                                                                   | [intl/request.ts](intl/request.ts)                                                                                                               |
| Locale negotiation: the stored choice, then Accept-Language through `negotiateLocale` (`/core`)                                                                                    | [intl/locale.ts](intl/locale.ts), [test/locale.test.ts](test/locale.test.ts)                                                                     |
| `<IntlProvider>` from `getIntl()`, `<html lang>`                                                                                                                                   | [app/layout.tsx](app/layout.tsx)                                                                                                                 |
| Fuse's own strings: its `LocaleProvider` driven by the request's locale (`en` → `en-US`)                                                                                           | [components/app-shell.tsx](components/app-shell.tsx), [intl/locale.ts](intl/locale.ts)                                                           |
| Server components: `<T>`, `<Val>`, `<Plural>`, `<Select>`, tags                                                                                                                    | [app/page.tsx](app/page.tsx) (the welcome)                                                                                                       |
| Server components: `getT()`, `getFormat()`, `t.from`; the layout `getIntl()`                                                                                                       | [app/page.tsx](app/page.tsx), [app/invoices/page.tsx](app/invoices/page.tsx), [app/settings/page.tsx](app/settings/page.tsx)                     |
| Formats in the configured zone: number, currency, date, relative time (explicit `now`)                                                                                             | [app/page.tsx](app/page.tsx) (February invoices, key figures, activity)                                                                          |
| Formats: list, and a date range (server only, see Notes)                                                                                                                           | [app/page.tsx](app/page.tsx), [app/invoices/page.tsx](app/invoices/page.tsx)                                                                     |
| One English word, two translations: `<T context>` beside a `msg()` context                                                                                                         | [app/page.tsx](app/page.tsx) (the Open button), [intl/messages.ts](intl/messages.ts) (the Open state)                                            |
| `msg()` descriptors declared at module scope, rendered with `t.from`                                                                                                               | [intl/messages.ts](intl/messages.ts), [components/app-config.ts](components/app-config.ts)                                                       |
| Data with no English in it: labels are descriptors, sentences are data plus one message                                                                                            | [data/power-data.ts](data/power-data.ts), [app/page.tsx](app/page.tsx) (`activityText`)                                                          |
| Client components: `useT()`, `useFormat()`, ICU plurals, `t.from` in one message; dates formatted in the browser on a click (the invoice Sheet, which never renders on the server) | [components/metering-points-table.tsx](components/metering-points-table.tsx), [components/invoice-detail.tsx](components/invoice-detail.tsx)     |
| Translated Fuse props: table headers as `<T>`, filter fields and labels built under `t`                                                                                            | [components/metering-points-table.tsx](components/metering-points-table.tsx), [components/command-menu.tsx](components/command-menu.tsx)         |
| Locale switch: `useLocaleSwitch` with a server action, its failures shown                                                                                                          | [components/locale-switcher.tsx](components/locale-switcher.tsx), on [app/settings/page.tsx](app/settings/page.tsx)                              |
| Client state that survives a switch: the settings form's draft                                                                                                                     | [components/settings-form.tsx](components/settings-form.tsx)                                                                                     |
| Server action returning translated text: Save settings, its argument parsed as unknown input                                                                                       | [app/actions.ts](app/actions.ts), [data/settings-draft.ts](data/settings-draft.ts), [components/settings-form.tsx](components/settings-form.tsx) |
| API route: `getT()` in a route handler, as in a server component (the test alert)                                                                                                  | [app/api/greeting/route.ts](app/api/greeting/route.ts), [components/settings-form.tsx](components/settings-form.tsx)                             |
| Answers keyed by the locale, so a switch clears text given in the old language                                                                                                     | [components/answer-request.tsx](components/answer-request.tsx)                                                                                   |
| Vitest: `intlCatalogs()` compiles `*.po` imports; the catalog check as a global setup                                                                                              | [vitest.config.ts](vitest.config.ts), [test/catalog.test.ts](test/catalog.test.ts)                                                               |
| Playwright specs, all four locales, with JavaScript on and off; the expected text per locale                                                                                       | [tests/intl.spec.ts](tests/intl.spec.ts), [tests/settings.spec.ts](tests/settings.spec.ts), [tests/expected-text.ts](tests/expected-text.ts)     |
| Fuse: Tailwind v4 through PostCSS, its components, charts and themes                                                                                                               | [app/globals.css](app/globals.css), [postcss.config.mjs](postcss.config.mjs), [app/layout.tsx](app/layout.tsx)                                   |

## Not shown here

What an app does not call itself, and `/effect`, which has an example of its own:

- `keyOf`, `serialize` and `SERIALIZER_VERSION` (`/core`): the source key, its serializer and its
  version, which the runtime and the tools compute for the app.
- `createLocaleSwitcher` (`/core`), the standalone framework-free switch: each call makes its own
  queue, which its caller owns (`useLocaleSwitch` shares one per router instead).
- `resolveIntlConfig` (`/core`), which `createRequestConfig` wraps; a route that rewrites its
  request's cookies calls it (the runtime README's Next notes).
- `loadCatalog`, `compileCatalog` and its `CatalogCompileError` (`/compile`), for Node without a
  bundler: every catalog here is a `*.po` import, which `withIntl` compiles in the app and
  `intlCatalogs()` in Vitest. The [Effect example](../effect-example) loads its catalogs with
  `loadCatalog`.
- `/effect` (`CurrentIntl`): this app does not use Effect. The [Effect example](../effect-example)
  shows `CurrentIntl` in an Effect HTTP API.

## Notes

- **No page, layout or action imports setup code.** `withIntl` aliases the runtime's request config
  to [intl/request.ts](intl/request.ts), so `getIntl`, `getT`, `getFormat` and the server `<T>` read
  each request through it. It looks for that file when `next.config.ts` loads: restart `next dev`
  after creating it.
- **The adapter reads the locale cookie with `cookies()`**, as Next code does. Inside the locale
  switch's server action that store already holds the cookie the action set, so the page Next
  re-renders in the action's response shows the new language, the shell around it included
  (`useLocaleSwitch(setLocale, { refresh: "server-action" })`). The API route reads its translator with
  `getT()`, through the same request config: there `cookies()` and the headers are the route's
  request's.
- **The switcher lives on Settings, beside the client state it keeps.** A route change unmounts a
  page's state, so the state a switch must keep is the form on the switcher's own page: what the
  visitor typed survives the switch, under labels in the new language. The test alert (the API
  route) and Save (a server action) sit there too, keyed by the locale, so a switch clears an answer
  given in the old language. The switcher calls `useLocaleSwitch` itself: every mount under the
  App Router shares one switch queue, so a Settings mounted again joins the queue a switch from
  an earlier visit is still in.
- **On a phone, the sidebar closes on every navigation.** Its Sheet closes in the render that shows
  the new page, the browser's Back and Forward included, so it never covers the page it led to.
- **Fuse's strings are Fuse's.** The sidebar toggle, the table pagination and the chart tables read
  Fuse's own dictionaries through its `LocaleProvider`, which the shell feeds the request's locale
  (`fuseLocale` in [intl/locale.ts](intl/locale.ts)) and the configured zone. Everything the app
  writes goes through `<T>`, `useT`, `getT` or `msg()`. A Fuse prop that takes a string gets one
  translated where `t` is bound (`useT()` in the component, or a `useMemo` on `[t]`): `t` itself is
  never passed, so the extractor sees every message.
- **Units follow Fuse's.** Fuse writes the krone's minor unit as _øre_ in Bokmål, _öre_ in Swedish
  and _äyri_ in Finnish (its chart axes); the app's messages say it the same way. Finnish has no
  narrow symbol for the krone, so `price` amounts read `NOK` there and `kr` elsewhere.
- **Relative times take an explicit `now`.** The dashboard's moment is fixed (`AS_OF` in
  [data/power-data.ts](data/power-data.ts)) so the server render and the specs agree; an app passes
  its clock's.
- **A date a client component shows is formatted on the server.** A client component renders on the
  server and again as the page hydrates, and Node's ICU and the browser's can write one date two
  ways (English "Mar 29, 2026, 1:20 PM" in Node, "Mar 29, 2026 at 1:20 PM" in WebKit; a date range's
  spacing between ICU releases). So the overview hands Fuse's charts their x as categories the server labelled
  ([components/overview-charts.ts](components/overview-charts.ts)), the invoices page hands the table
  its due dates' labels, and a date range formats only in a server component: the page hydrates to
  the server's text by construction.
- **Save parses what it receives.** A server action is an endpoint anyone can post to, so
  `saveSettings` parses its argument as unknown input with one Zod schema
  ([data/settings-draft.ts](data/settings-draft.ts)) before it parses the fields, and a body that
  does not parse is a draft to fix.
- **Toasts render `<T>`, not strings.** The toast viewport lives in the shell and outlives a switch,
  so a notification on screen reads in the language the page has now.
- **Without JavaScript, a narrow screen still reaches every page.** Below `md` the sidebar is a
  Sheet only script opens, so the shell renders the pages as plain links inside `<noscript>`.
- **The sidebar remembers its state in the app's own cookie**, `next-example-sidebar`, which the
  layout reads for the first paint, as the locale cookie is per app. Fuse's `Sidebar.Provider`, at
  its default `bounds="page"`, also writes its fixed `sidebar:state` cookie, shared by both example
  apps on localhost; the app never reads it.
- **Lint.** The workspace's `.oxlintrc.json` already runs `elmera-intl/extractable` here. In an app of
  your own:

  ```json
  {
    "jsPlugins": [{ "name": "elmera-intl", "specifier": "@elmeragroup/intl-tools/oxlint" }],
    "rules": { "elmera-intl/extractable": "error" }
  }
  ```

- **Type-check** reads the packages' built declarations (`tsrs --noEmit --customConditions null`),
  as an app installing them from npm does.
