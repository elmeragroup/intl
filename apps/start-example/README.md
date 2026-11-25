# TanStack Start example

`@elmeragroup/intl` and `@elmeragroup/intl-tools` in a TanStack Start app, in English (the source
language) and Norwegian Bokmål. Bare bones on purpose: one route, no styling, no business logic,
and the packages' features a Start app uses (the few left out are listed below).

From the repository root, through turbo, which builds the packages the app links first (a fresh
checkout has no `dist`):

```sh
pnpm turbo run dev --filter=@elmeragroup/start-example   # vite dev on :3031; the intl plugin watches the messages
pnpm --filter @elmeragroup/start-example exec playwright install chromium   # once: the browser the specs run in
pnpm turbo run test:run --filter=@elmeragroup/start-example   # check the catalog, then the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/start-example   # build (which runs check), then the Playwright specs
```

## Where each feature lives

| Feature                                                                               | File                                                                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Build plugin: `intl()` compiles `*.po`, watches in dev, checks on build               | [vite.config.ts](vite.config.ts)                                                                                                 |
| CLI config: sources, catalogs, locales, formats                                       | [elmera-intl.json](elmera-intl.json)                                                                                             |
| CLI scripts: `intl:extract`, `intl:check`                                             | [package.json](package.json)                                                                                                     |
| Catalog: the PO translators edit; typed `*.po` imports                                | [src/intl/nb.po](src/intl/nb.po), [src/intl/catalogs.d.ts](src/intl/catalogs.d.ts)                                               |
| Named formats, shared by the runtime and `check`                                      | [src/intl/formats.ts](src/intl/formats.ts)                                                                                       |
| Server adapter: locale, catalog, time zone                                            | [src/intl/adapter.ts](src/intl/adapter.ts)                                                                                       |
| Locale negotiation: cookie (Start's `getCookie`), then Accept-Language weights        | [src/intl/adapter.ts](src/intl/adapter.ts), [src/intl/locale.ts](src/intl/locale.ts), [test/locale.test.ts](test/locale.test.ts) |
| Root loader: `loadIntlConfig`; `<IntlProvider>`; `createCatalogReload`                | [src/routes/\_\_root.tsx](src/routes/__root.tsx), [src/intl/intl.functions.ts](src/intl/intl.functions.ts)                       |
| Route: `<T>`, `<Val>`, `<Plural>`, `<Select>`, tags, `useIntl`, `t.from`              | [src/routes/index.tsx](src/routes/index.tsx)                                                                                     |
| One English word, two translations: `<T context>` beside a `msg()` context            | [src/routes/index.tsx](src/routes/index.tsx), [src/intl/messages.ts](src/intl/messages.ts)                                       |
| Formats: number, date in the configured zone, relative time, list                     | [src/routes/index.tsx](src/routes/index.tsx), [src/components/cart.tsx](src/components/cart.tsx)                                 |
| Route loader: text translated and a date range formatted on the server (`createIntl`) | [src/server/shop.functions.ts](src/server/shop.functions.ts)                                                                     |
| `msg()` descriptors declared at module scope, one with a context                      | [src/intl/messages.ts](src/intl/messages.ts)                                                                                     |
| Client state: `useT()`, `useFormat()`, ICU plural, `t.from` in one message            | [src/components/cart.tsx](src/components/cart.tsx)                                                                               |
| Locale switch: `useLocaleSwitch` with a server function, its failures shown           | [src/components/locale-switcher.tsx](src/components/locale-switcher.tsx)                                                         |
| A failed loader, such as the reload after a switch: translated, with a retry          | [src/components/load-error.tsx](src/components/load-error.tsx), [src/router.tsx](src/router.tsx)                                 |
| Server function returning translated text                                             | [src/server/shop.functions.ts](src/server/shop.functions.ts)                                                                     |
| API route on Effect: `CurrentIntl.provide` with `loadIntlConfig`                      | [src/routes/api/greeting.ts](src/routes/api/greeting.ts)                                                                         |
| Vitest: `intlCatalogs()` compiles `*.po` imports; the catalog check as a global setup | [vitest.config.ts](vitest.config.ts), [test/catalog.test.ts](test/catalog.test.ts)                                               |
| Playwright specs, both locales                                                        | [tests/intl.spec.ts](tests/intl.spec.ts)                                                                                         |

## Not shown here

Only what an app does not call itself, and the React Server Components API Start has no use for:

- `keyOf`, `serialize` and `SERIALIZER_VERSION` (`/core`): the source key, its serializer and its
  version, which the runtime and the tools compute for the app.
- `resolveIntlConfig` and `createLocaleSwitcher` (`/core`), which `loadIntlConfig` and
  `useLocaleSwitch` wrap.
- `loadCatalog`, `compileCatalog` and its `CatalogCompileError` (`/compile`), for Node scripts
  without a bundler: every catalog
  here is a `*.po` import, which `intl()` compiles in the app and `intlCatalogs()` in Vitest.
- `/server` (`getT`, `getFormat`, `getIntl`): the React Server Components
  API, shown in the Next example. A Start route reads the translator from the provider (`useT`,
  `useIntl`).

## Notes

- **A switch re-runs the loaders.** `setLocale` stores the cookie; `useLocaleSwitch` then calls
  `router.invalidate({ sync: true })`, so the root loader returns the new catalog and the provider,
  the loader text and the rest of the page change in one commit while client state survives.
- **A server function builds its translator in its handler** (`createIntl(await loadIntlConfig(...))`):
  extraction traces a translator only to a factory call in the same file.
- **The date range is formatted in the loader**, not in the component: its spacing differs between
  ICU releases (in English, Node 24's ICU 78.2 uses U+2009 and U+202F where Node 26 and Chromium put
  plain spaces), so a range formatted on both sides of hydration can differ.
- **Relative times take an explicit `now`.** The example fixes it (`NOW` in
  [src/intl/messages.ts](src/intl/messages.ts)) so the server render, the hydrated page and the specs
  agree; an app passes its clock's.
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
