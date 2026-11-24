# TanStack Start example

`@elmeragroup/intl` and `@elmeragroup/intl-tools` in a TanStack Start app, in English (the source
language), Norwegian Bokmål, Swedish and Finnish. The app is a power retailer's back office built
on Elmera's [Fuse](https://github.com/elmeragroup/fuse) design system: Fuse's app-shell block
(sidebar, header, command menu, overview, invoices, metering points and settings) with every string
translated, and the packages' features a Start app uses placed where such an app would use them
(the few left out are listed below). The [Next.js example](../next-example) is the same portal on
Next's App Router.

The block's source is Fuse's docs app at commit
[`9be80460091e90854ec169986b4be7411d2e592f`](https://github.com/elmeragroup/fuse/tree/9be80460091e90854ec169986b4be7411d2e592f/apps/docs/src/app/%28docs%29/blocks/app-shell/demos)
(`apps/docs/src/app/(docs)/blocks/app-shell/demos` and its preview routes), the commit
`@elmeragroup/fuse@0.1.0-canary.208` was built from. Fuse is MIT-licensed, © Elmera Group; each
ported file names the block file it came from.

From the repository root, through turbo, which builds the packages the app links first (a fresh
checkout has no `dist`):

```sh
pnpm turbo run dev --filter=@elmeragroup/start-example   # vite dev on :3031; the intl plugin watches the messages
pnpm --filter @elmeragroup/start-example exec playwright install chromium webkit   # once: the browsers the specs run in
pnpm turbo run test:run --filter=@elmeragroup/start-example   # check the catalogs, then the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/start-example   # build (which runs check), then the Playwright specs
```

## Where each feature lives

| Feature                                                                                                                                                                       | File                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build plugin: `intl()` compiles `*.po`, watches in dev, checks on build                                                                                                       | [vite.config.ts](vite.config.ts)                                                                                                                                                                 |
| CLI config: sources, catalogs, locales, formats                                                                                                                               | [elmera-intl.json](elmera-intl.json)                                                                                                                                                             |
| CLI scripts: `intl:extract`, `intl:check`                                                                                                                                     | [package.json](package.json)                                                                                                                                                                     |
| Catalogs: the POs translators edit; typed `*.po` imports                                                                                                                      | [src/intl/nb.po](src/intl/nb.po), [src/intl/sv.po](src/intl/sv.po), [src/intl/fi.po](src/intl/fi.po), [src/intl/catalogs.d.ts](src/intl/catalogs.d.ts)                                           |
| `#, ignore-same`: a translation that is the English on purpose (placeholders, units)                                                                                          | [src/intl/nb.po](src/intl/nb.po), [src/intl/sv.po](src/intl/sv.po), [src/intl/fi.po](src/intl/fi.po)                                                                                             |
| Named formats, shared by the runtime and `check`: a date, a time, kroner, a change, a spot price                                                                              | [src/intl/formats.ts](src/intl/formats.ts)                                                                                                                                                       |
| Server adapter: locale from Start's `getCookie`, the four catalogs, the market's time zone                                                                                    | [src/intl/adapter.ts](src/intl/adapter.ts)                                                                                                                                                       |
| Locale negotiation: the stored choice, then Accept-Language weights                                                                                                           | [src/intl/locale.ts](src/intl/locale.ts), [test/locale.test.ts](test/locale.test.ts)                                                                                                             |
| Root loader: `loadIntlConfig`; `<IntlProvider>`, `<html lang>`; `createCatalogReload`                                                                                         | [src/routes/\_\_root.tsx](src/routes/__root.tsx), [src/intl/intl.functions.ts](src/intl/intl.functions.ts)                                                                                       |
| Fuse's own strings: its `LocaleProvider` driven by the request's locale (`en` → `en-US`)                                                                                      | [src/components/app-shell.tsx](src/components/app-shell.tsx), [src/intl/locale.ts](src/intl/locale.ts)                                                                                           |
| Route: `<T>`, `<Val>`, `<Plural>`, `<Select>`, tags (a router `<Link>`), `useIntl`                                                                                            | [src/routes/index.tsx](src/routes/index.tsx) (the welcome)                                                                                                                                       |
| `useT()`, `useFormat()`, `t.from` in every route; the document title in the page header                                                                                       | [src/routes/index.tsx](src/routes/index.tsx), [src/routes/invoices.tsx](src/routes/invoices.tsx), [src/components/page-header.tsx](src/components/page-header.tsx)                               |
| Formats in the configured zone: number, currency, date, relative time (explicit `now`)                                                                                        | [src/server/portal.functions.ts](src/server/portal.functions.ts) (dates, activity), [src/routes/index.tsx](src/routes/index.tsx) (key figures)                                                   |
| Formats: list                                                                                                                                                                 | [src/routes/index.tsx](src/routes/index.tsx) (price areas)                                                                                                                                       |
| One English word, two translations: `<T context>` beside a `msg()` context                                                                                                    | [src/routes/index.tsx](src/routes/index.tsx) (the Open button), [src/intl/messages.ts](src/intl/messages.ts) (the Open state)                                                                    |
| `msg()` descriptors declared at module scope, rendered with `t.from`                                                                                                          | [src/intl/messages.ts](src/intl/messages.ts), [src/components/app-config.ts](src/components/app-config.ts)                                                                                       |
| Data with no English in it: labels are descriptors, sentences are data plus one message                                                                                       | [src/data/power-data.ts](src/data/power-data.ts), [src/server/portal.functions.ts](src/server/portal.functions.ts) (`activityText`)                                                              |
| Route loaders: text translated, every date the page shows formatted (see Notes), `createIntl`                                                                                 | [src/server/portal.functions.ts](src/server/portal.functions.ts), [src/routes/index.tsx](src/routes/index.tsx), [src/routes/invoices.tsx](src/routes/invoices.tsx)                               |
| Client state: `useT()`, `useFormat()`, ICU plurals, `t.from` in one message; dates formatted in the browser on a click (the invoice Sheet, which never renders on the server) | [src/components/metering-points-table.tsx](src/components/metering-points-table.tsx), [src/components/invoice-detail.tsx](src/components/invoice-detail.tsx)                                     |
| Translated Fuse props: table headers as `<T>`, filter fields and labels built under `t`                                                                                       | [src/components/metering-points-table.tsx](src/components/metering-points-table.tsx), [src/components/command-dialog.tsx](src/components/command-dialog.tsx)                                     |
| Locale switch: `useLocaleSwitch` with a server function, its failures shown                                                                                                   | [src/components/locale-switcher.tsx](src/components/locale-switcher.tsx), on [src/routes/settings.tsx](src/routes/settings.tsx)                                                                  |
| Client state that survives a switch, and a failed reload after one: the settings draft, held above the page                                                                   | [src/components/settings-draft.tsx](src/components/settings-draft.tsx), [src/components/settings-form.tsx](src/components/settings-form.tsx)                                                     |
| A failed loader, such as the reload after a switch: translated, with a retry                                                                                                  | [src/components/load-error.tsx](src/components/load-error.tsx), [src/router.tsx](src/router.tsx)                                                                                                 |
| Server function returning translated text: Save settings, its argument parsed as unknown input                                                                                | [src/server/portal.functions.ts](src/server/portal.functions.ts), [src/data/settings-draft.ts](src/data/settings-draft.ts), [src/components/settings-form.tsx](src/components/settings-form.tsx) |
| API route: `createIntl(await loadIntlConfig(adapter, request))` in a server route (the test alert)                                                                            | [src/routes/api/greeting.ts](src/routes/api/greeting.ts), [src/components/settings-form.tsx](src/components/settings-form.tsx)                                                                   |
| Answers keyed by the locale, so a switch clears text given in the old language                                                                                                | [src/components/answer-request.tsx](src/components/answer-request.tsx)                                                                                                                           |
| Vitest: `intlCatalogs()` compiles `*.po` imports; the catalog check as a global setup                                                                                         | [vitest.config.ts](vitest.config.ts), [test/catalog.test.ts](test/catalog.test.ts)                                                                                                               |
| Playwright specs, all four locales, with JavaScript on and off; the expected text per locale                                                                                  | [tests/intl.spec.ts](tests/intl.spec.ts), [tests/settings.spec.ts](tests/settings.spec.ts), [tests/expected-text.ts](tests/expected-text.ts)                                                     |
| Fuse: Tailwind v4 through its Vite plugin, its components, charts and themes                                                                                                  | [src/styles.css](src/styles.css), [vite.config.ts](vite.config.ts), [src/routes/\_\_root.tsx](src/routes/__root.tsx)                                                                             |

## Not shown here

What an app does not call itself, the React Server Components API Start has no use for, and
`/effect`, which has an example of its own:

- `keyOf`, `serialize` and `SERIALIZER_VERSION` (`/core`): the source key, its serializer and its
  version, which the runtime and the tools compute for the app.
- `resolveIntlConfig` (`/core`), which `loadIntlConfig` wraps.
- `createLocaleSwitcher` (`/core`), the standalone framework-free switch: each call makes its own
  queue, which its caller owns (`useLocaleSwitch` shares one per router instead).
- `loadCatalog`, `compileCatalog` and its `CatalogCompileError` (`/compile`), for Node without a
  bundler: every catalog here is a `*.po` import, which `intl()` compiles in the app and
  `intlCatalogs()` in Vitest. The [Effect example](../effect-example) loads its catalogs with
  `loadCatalog`.
- `/server` (`getT`, `getFormat`, `getIntl`): the React Server Components
  API, shown in the Next example. A Start route reads the translator from the provider (`useT`,
  `useIntl`).
- `/effect` (`CurrentIntl`): this app does not use Effect. The [Effect example](../effect-example)
  shows `CurrentIntl` in an Effect HTTP API.

## Notes

- **A switch re-runs the loaders.** `setLocale` stores the cookie; `useLocaleSwitch` then calls
  `router.invalidate({ sync: true })`, so the root loader returns the new catalog and the provider,
  the shell, the loader text and the rest of the page change in one commit while client state (the
  settings draft) survives. The overview's and the invoices' loaders reload a page cached from an
  earlier visit before showing it (`staleReloadMode: "blocking"`): their data is text in the language
  it loaded in, so a return after a switch never paints the old language.
- **The switcher lives on Settings, beside the client state it keeps.** A route change unmounts a
  page's state, so the state a switch must keep is the form on the switcher's own page: what the
  visitor typed survives the switch, under labels in the new language. The test alert (the API
  route) and Save (a server function) sit there too, keyed by the locale, so a switch clears an
  answer given in the old language. The switcher calls `useLocaleSwitch` itself: every mount under
  the router shares one switch queue, so a Settings mounted again joins the queue a switch held
  from an earlier visit is in, shows it as busy, and that switch cannot land after a newer one.
- **A server function or server route builds its translator in its handler**
  (`createIntl(await loadIntlConfig(...))`): extraction traces a translator only to a factory call in
  the same file. Save parses the draft it receives as unknown input, with one Zod schema
  ([src/data/settings-draft.ts](src/data/settings-draft.ts)), before parsing its fields, since it
  crossed the network.
- **Every date and time a page shows formats in its loader**, not in a component: the sentences that
  hold one, the relative times, the charts' x labels and the invoice table's due cells. A component
  renders on the server and again as the page hydrates, and Node's ICU and the browser's can write one
  value two ways (English "Mar 29, 2026, 1:20 PM" against WebKit's "Mar 29, 2026 at 1:20 PM",
  Bokmål's "døgn" against "dager", a date range's spacing between ICU releases); loader data reaches
  the browser as the server made it, so the page hydrates to the server's text by construction. The
  charts take their x as a category, already a label. Numbers, plurals and selects stay with the
  components, and the specs fail on any hydration error.
- **Fuse's strings are Fuse's.** The sidebar toggle, the table pagination and the chart tables read
  Fuse's own dictionaries through its `LocaleProvider`, which the shell feeds the request's locale
  (`fuseLocale` in [src/intl/locale.ts](src/intl/locale.ts)) and the configured zone. Everything the
  app writes goes through `<T>`, `useT` or `msg()`. A Fuse prop that takes a string gets one
  translated where `t` is bound (`useT()` in the component, or a `useMemo` on `[t]`): `t` itself is
  never passed, so the extractor sees every message.
- **Units follow Fuse's.** Fuse writes the krone's minor unit as _øre_ in Bokmål, _öre_ in Swedish
  and _äyri_ in Finnish (its chart axes); the app's messages say it the same way. Finnish has no
  narrow symbol for the krone, so `price` amounts read `NOK` there and `kr` elsewhere.
- **Relative times take an explicit `now`.** The dashboard's moment is fixed (`AS_OF` in
  [src/data/power-data.ts](src/data/power-data.ts)), and the loader measures from it, so every load
  and the specs agree; an app passes its clock's.
- **The document title is React's.** Each page's header renders a `<title>` (one message, the page's
  name a placeholder before the app's), which React 19 hoists into the head on the server and
  replaces after a navigation or a switch; no route declares one in `head`.
- **Focus moves to the new page's title after a client navigation.** TanStack Router restores
  scroll but moves no focus, so the shell does, as the Next example's does, once the router's
  resolved location changes: by then the incoming page has rendered, and its title is the one there.
  On a phone, the sidebar's Sheet closes on every navigation, the browser's Back and Forward included,
  in the render that shows the new page.
- **The shell names the page by its matched route**, not the path as typed: the router matches
  without regard to case, so `/SETTINGS` is Settings in the breadcrumb and the sidebar, and keeps
  the same settings draft as `/settings` ([src/components/current-page.ts](src/components/current-page.ts)).
- **The command menu loads on first use.** The header's search button and ⌘K are in every page's
  first load; the menu itself, Fuse's command palette, is a dynamic import the first opening fetches.
  A download that fails leaves the page as it is and says search is unavailable, with an action that
  reloads the page: a browser may keep a module whose fetch failed (WebKit does), so asking again in
  place is no retry. The launcher handles the rejected import itself rather than through
  `React.lazy`, which would throw it to the app's error boundary.
- **Toasts render `<T>`, not strings.** The toast viewport lives in the shell and outlives a switch,
  so a notification on screen reads in the language the page has now.
- **Without JavaScript, a narrow screen still reaches every page.** Below `md` the sidebar is a
  Sheet only script opens, so the shell renders the pages as plain links inside `<noscript>`.
- **The sidebar remembers its state in the app's own cookie**, `start-example-sidebar`, which the
  root loader reads for the first paint, as the locale cookie is per app. Fuse's `Sidebar.Provider`,
  at its default `bounds="page"`, also writes its fixed `sidebar:state` cookie, shared by both
  example apps on localhost; the app never reads it.
- **`src/routeTree.gen.ts` is generated** by the Start plugin on `dev` and `build`, and committed so
  the type-check runs without a build.
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
