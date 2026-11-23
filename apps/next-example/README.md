# Next.js example

`@elmeragroup/intl` and `@elmeragroup/intl-tools` in a Next.js App Router app, in English (the
source language) and Norwegian Bokmål. Bare bones on purpose: one page, no styling, no business
logic, and the packages' features a Next app uses (the few left out are listed below).

From the repository root, through turbo, which builds the packages the app links first (a fresh
checkout has no `dist`):

```sh
pnpm turbo run dev --filter=@elmeragroup/next-example   # next dev on :3030, with elmera-intl extract --watch
pnpm --filter @elmeragroup/next-example exec playwright install chromium   # once: the browser the specs run in
pnpm turbo run test:run --filter=@elmeragroup/next-example   # check the catalog, then the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/next-example   # check, build, then the Playwright specs
```

## Where each feature lives

| Feature                                                                               | File                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Build plugin: `withIntl` compiles `*.po` imports and aliases `intl/request.ts`        | [next.config.ts](next.config.ts)                                                   |
| CLI config: sources, catalogs, locales, formats                                       | [elmera-intl.json](elmera-intl.json)                                               |
| CLI scripts: `check` before `build`, `extract --watch` beside `dev`                   | [package.json](package.json)                                                       |
| Catalog: the PO translators edit; typed `*.po` imports                                | [intl/nb.po](intl/nb.po), [intl/catalogs.d.ts](intl/catalogs.d.ts)                 |
| Named formats, shared by the runtime and `check`                                      | [intl/formats.ts](intl/formats.ts)                                                 |
| Server adapter: locale from `cookies()`, catalog, time zone                           | [intl/adapter.ts](intl/adapter.ts)                                                 |
| Request config: `createRequestConfig(adapter)`, read by `getIntl` with no import      | [intl/request.ts](intl/request.ts)                                                 |
| Locale negotiation: the stored choice, then Accept-Language weights                   | [intl/locale.ts](intl/locale.ts), [test/locale.test.ts](test/locale.test.ts)       |
| `<IntlProvider>` from `getIntl()`, `<html lang>`                                      | [app/layout.tsx](app/layout.tsx)                                                   |
| Server components: `<T>`, `<Val>`, `<Plural>`, `<Select>`, tags                       | [app/page.tsx](app/page.tsx)                                                       |
| Server components: `getT()`, `getFormat()`, `t.from`; the layout `getIntl()`          | [app/page.tsx](app/page.tsx)                                                       |
| Formats: number, date and date range in the configured zone, relative time, list      | [app/page.tsx](app/page.tsx), [components/cart.tsx](components/cart.tsx)           |
| One English word, two translations: `<T context>` beside a `msg()` context            | [app/page.tsx](app/page.tsx), [intl/messages.ts](intl/messages.ts)                 |
| `msg()` descriptors declared at module scope, one with a context                      | [intl/messages.ts](intl/messages.ts)                                               |
| Client components: `useT()`, `useFormat()`, ICU plural, `t.from` in one message       | [components/cart.tsx](components/cart.tsx)                                         |
| Locale switch: `useLocaleSwitch` with a server action, its failures shown             | [components/locale-switcher.tsx](components/locale-switcher.tsx)                   |
| Server action returning translated text                                               | [app/actions.ts](app/actions.ts)                                                   |
| API route on Effect: `CurrentIntl.provide` with `resolveIntlConfig`                   | [app/api/greeting/route.ts](app/api/greeting/route.ts)                             |
| Vitest: `intlCatalogs()` compiles `*.po` imports; the catalog check as a global setup | [vitest.config.ts](vitest.config.ts), [test/catalog.test.ts](test/catalog.test.ts) |
| Playwright specs, both locales                                                        | [tests/intl.spec.ts](tests/intl.spec.ts)                                           |

## Not shown here

Only what an app does not call itself:

- `keyOf`, `serialize` and `SERIALIZER_VERSION` (`/core`): the source key, its serializer and its
  version, which the runtime and the tools compute for the app.
- `createLocaleSwitcher` (`/core`), the framework-free switch that `useLocaleSwitch` wraps.
- `loadCatalog`, `compileCatalog` and its `CatalogCompileError` (`/compile`), for Node scripts
  without a bundler: every catalog
  here is a `*.po` import, which `withIntl` compiles in the app and `intlCatalogs()` in Vitest.

## Notes

- **No page, layout or action imports setup code.** `withIntl` aliases the runtime's request config
  to [intl/request.ts](intl/request.ts), so `getIntl`, `getT`, `getFormat` and the server `<T>` read
  each request through it. It looks for that file when `next.config.ts` loads: restart `next dev`
  after creating it.
- **The adapter reads the locale cookie with `cookies()`**, as Next code does. Inside the locale
  switch's server action that store already holds the cookie the action set, so the page Next
  re-renders in the action's response shows the new language
  (`useLocaleSwitch(setLocale, { refresh: "server-action" })`). The API route hands the adapter its
  own `Request` for Accept-Language; `cookies()` there is that request's cookies.
- **`next.config.ts` annotates its config as `NextConfig`.** The `satisfies NextConfig` form fails to
  type-check against `withIntl` ([#21](https://github.com/elmeragroup/intl/issues/21)).
- **Relative times take an explicit `now`.** The example fixes it (`NOW` in
  [intl/messages.ts](intl/messages.ts)) so the server render and the specs agree; an app passes its
  clock's.
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
