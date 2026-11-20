# 0002: Naming

Date: 2026-11-18. Status: accepted.

## Context

Before the first npm publish the package installed as `@elmeragroup/intl` but spoke "I18n": `createI18n`, `useI18n`, `<I18nProvider>`, a `type I18n`. `/core` and `/start` each exported a different `loadI18nConfig`. Seven subpaths that exist only so `@elmeragroup/intl-tools` can import or alias them (the serializer, the ICU pipeline, the formatter pair, the mode pair, the client half of `/react`) sat beside the public ones, and the oxlint rule id `intl/extractable` had no brand. Nothing is published, so renaming costs nothing now and a semver major later.

## Options

1. Keep "I18n". No churn, but the API disagrees with the install name and with the bin and config (`elmera-intl`, `elmera-intl.json`).
2. Rename to "Intl", with the instance type named `Intl`. Shortest, but a type named `Intl` shadows the global in every file that imports it (`new Intl.NumberFormat` stops compiling).
3. Rename to "Intl", with the instance type named `IntlInstance`.

## Decision

Option 3, with the rules below. `/core`'s loader became `resolveIntlConfig`, `/start`'s `loadIntlConfig`; the tools-only subpaths moved under `/internal/*`; the plugin became `elmera-intl`.

### Vocabulary

- The package is intl. The instance is an `IntlInstance`, and a variable holding one is named `intl` (`const intl = createIntl(...)`, `intl.t("literal")`).
- Not `Intl`: it shadows the global `Intl`.
- The formatter is `format`: `intl.format`, `useFormat()`, `getFormat()`, and a variable holding one is `format` (`format.dateTime(d, "long")`). Not `useFormatter`: the hook is named after the instance field, as `useT` is after `t`. Its methods keep next-intl's names (`dateTime`, `number`, `relativeTime`, `list`, `dateTimeRange`), so a call site moves by renaming the hook.
- react-intl and use-intl also export `createIntl`, `useIntl`, `IntlProvider` and `IntlConfig`. We accept the collision: the names match the install name, and an app imports ours from a distinct specifier (`@elmeragroup/intl/react`), so the two never meet in one import.

### Prefixes

| Prefix or form                                         | Meaning                    | Examples                                                                                  |
| ------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| `use*`                                                 | React hook                 | `useT`, `useIntl`, `useFormat`, `useLocaleSwitch`                                         |
| `get*`                                                 | Async, server-only         | `getT`, `getIntl`, `getFormat`                                                            |
| `create*`                                              | Plain factory              | `createIntl`, `createLocaleSwitcher`, `createCatalogReload`                               |
| `compile*`                                             | Build-time compiler        | `compileCatalog` (intl-tools `/compile`)                                                  |
| `configure*`                                           | One-time server wiring     | `configureRequestIntl`, `configureNextIntl`                                               |
| `load*`                                                | Framework loader step      | `loadIntlConfig` (`/start`), `loadCatalog` (intl-tools `/compile`, Node's catalog loader) |
| `resolve*`                                             | Adapter-contract primitive | `resolveIntlConfig` (`/core`)                                                             |
| Build plugin                                           | The host's convention      | `intl()`, `intlCatalogs()` (Vite), `withIntl()` (Next)                                    |
| PascalCase                                             | Component                  | `<T>`, `<Val>`, `<Plural>`, `<Select>`, `<IntlProvider>`                                  |
| `t("literal")`, `msg("literal")`, `t.from(descriptor)` | The message forms          | -                                                                                         |

### Subpaths

- One subpath per framework (`/next`, `/start`).
- A `/server` subpath only where the framework separates server modules: Next has `/next/server`, Start has none.
- The same hook name for the same concept in every adapter (`useLocaleSwitch` in `/next` and `/start`).
- `/internal/*` carries no semver promise. It exists for `@elmeragroup/intl-tools`, which shares the runtime's serializer, wire-key hash, catalog codec and formatter through it.

### Config fields

A field of the serializable config (`IntlConfig`, the provider's props, `ServerAdapter`'s static fields) takes next-intl's name when it means what next-intl's does: `locale`, `timeZone`, `formats` (type `Formats`). An app moving off next-intl passes the same value under the same name.

### Global names

A name in a global namespace carries the `elmera-` prefix: the npm bin `elmera-intl`, the config file `elmera-intl.json`, the oxlint plugin `elmera-intl` (rule `elmera-intl/extractable`). Imported names do not (`intl()`), since the specifier already scopes them.

### The public surface

Runtime exports only; types ride along with their subpath. `test/public-surface.test.ts` (and its intl-tools twin) checks the built packages against this table.

| Package      | Subpath        | Runtime exports                                                                                                                 |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `intl`       | `/core`        | `createIntl`, `msg`, `keyOf`, `serialize`, `SERIALIZER_VERSION`, `createLocaleSwitcher`, `resolveIntlConfig`                    |
| `intl`       | `/react`       | `IntlProvider`, `useIntl`, `useT`, `useFormat`, `T`, `Val`, `Plural`, `Select`, `msg`, `createIntl` (same under `react-server`) |
| `intl`       | `/server`      | `configureRequestIntl`, `getIntl`, `getT`, `getFormat`                                                                          |
| `intl`       | `/next`        | `useLocaleSwitch`                                                                                                               |
| `intl`       | `/next/server` | `configureNextIntl`                                                                                                             |
| `intl`       | `/start`       | `loadIntlConfig`, `useLocaleSwitch`, `createCatalogReload`                                                                      |
| `intl-tools` | `/vite`        | `intl`, `intlCatalogs`                                                                                                          |
| `intl-tools` | `/next`        | `withIntl`                                                                                                                      |
| `intl-tools` | `/compile`     | `compileCatalog`, `loadCatalog`, `CatalogCompileError`                                                                          |
| `intl-tools` | `/po`          | none: the `*.po` module declarations                                                                                            |
| `intl-tools` | `/oxlint`      | default (the `elmera-intl` plugin)                                                                                              |
| `intl-tools` | `/vitest`      | default (the catalog check)                                                                                                     |

## Consequences

- Every rename was outright, with no deprecated aliases: nothing outside this repo imports the package yet.
- A new export, subpath or rename fails the public-surface tests until this table changes with it.
- Apps already on react-intl or use-intl and ours must not import both under the same local names; none in this repo does.
- `@elmeragroup/i18n` (next-intl based, in the first adopting apps' monorepo when this was written) is a different private package and keeps its own names.
