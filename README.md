# Elmera intl

Source-keyed i18n for React, from the Elmera Group. Code is written in English, as hooks or JSX; a
build step extracts the messages into PO catalogs and compiles them, and a runtime with no ICU
parser formats the compiled catalogs per locale.

## Packages

| Package                                          | Purpose                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`@elmeragroup/intl`](packages/intl)             | The runtime: `<T>`, `useT`, `msg()`, `useFormat()`, one adapter per host (Next.js, TanStack Start), and `CurrentIntl` for Effect. |
| [`@elmeragroup/intl-tools`](packages/intl-tools) | Build time: the extractor, the `elmera-intl` CLI, PO catalogs, the compiler, build plugins and lint.                              |
| [`packages/intl-e2e`](packages/intl-e2e)         | Private. Fixture apps per host and their Playwright gates, on linked and on packed packages.                                      |
| `tooling/typescript`                             | Private. Shared TypeScript configuration.                                                                                         |
| `tooling/lint`                                   | Private. The workspace's own contracts as lint: the `elmera-workspace` oxlint plugin and manifest checks.                         |

Apps depend on `@elmeragroup/intl` and take `@elmeragroup/intl-tools` as a devDependency. The two
publish together under one version, with provenance, from `main`: a canary for each merge that leaves
a version bump pending, and stable versions through the Version Packages PR
([Releases](CONTRIBUTING.md#releases)).

Canary releases are off until the packages are ready
([#4](https://github.com/elmeragroup/intl/issues/4)). Once they are on, install a canary pair at one
exact version: resolve the tools' canary, write both entries at that exact version, then install.
The tools pin the runtime's exact version, so that pair always matches. Write the entries rather
than using `pnpm add`. Over an existing `^0.1.0` entry, `pnpm add` keeps the caret, even with
`--save-exact`, and saves the runtime as `^<canary>`; a later update could then move the runtime
alone.

```sh
V=$(npm view @elmeragroup/intl-tools@canary version) &&
  npm pkg set "dependencies.@elmeragroup/intl=$V" "devDependencies.@elmeragroup/intl-tools=$V" &&
  pnpm install
```

## Development

Requires macOS or glibc-based Linux (the Effect lint pass does not run on musl). Use the Node version in `.node-version` and the pnpm version in
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

[MIT](LICENSE). `@elmeragroup/intl` ships a [NOTICE](packages/intl/NOTICE) with the licenses of the
third-party code in its build (from next-intl, intl-messageformat and `@formatjs`), and its next-intl
conformance tests carry next-intl's license beside them
([LICENSE-next-intl](packages/intl/test/conformance/LICENSE-next-intl)).
