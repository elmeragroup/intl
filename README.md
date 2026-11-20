# Elmera intl

Source-keyed i18n for React, from the Elmera Group. Code is written in English, as hooks or JSX; a
build step extracts the messages into PO catalogs and compiles them, and a runtime with no ICU
parser formats the compiled catalogs per locale.

## Packages

| Package                                          | Purpose                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`@elmeragroup/intl`](packages/intl)             | The runtime: `<T>`, `useT`, `msg()`, `useFormat()`, and one adapter per host (Next.js, TanStack Start). |
| [`@elmeragroup/intl-tools`](packages/intl-tools) | Build time: the extractor, the `elmera-intl` CLI, PO catalogs, the compiler, build plugins and lint.    |
| [`packages/intl-e2e`](packages/intl-e2e)         | Private. Fixture apps per host and their Playwright gates, on linked and on packed packages.            |
| `tooling/typescript`                             | Private. Shared TypeScript configuration.                                                               |

Apps depend on `@elmeragroup/intl` and take `@elmeragroup/intl-tools` as a devDependency. The two
publish together under one version.

## Development

Requires macOS or Linux. Use the Node version in `.node-version` and the pnpm version in
`package.json`; pnpm downloads the pinned Node when it is missing.

```sh
pnpm install
pnpm dev           # rebuild packages on change
pnpm ci:checks     # format, lint, type-check and tests
pnpm test:e2e      # fixture apps on linked, then packed, packages
```

See [AGENTS.md](AGENTS.md#setup-and-checks) for the full list of commands, and read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request: every PR records the
[verification gates](CONTRIBUTING.md#verification) it ran.

## License

[MIT](LICENSE)
