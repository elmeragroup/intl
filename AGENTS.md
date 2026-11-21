# Working in this repository

This pnpm workspace holds `@elmeragroup/intl`, a source-keyed i18n runtime for React, and
`@elmeragroup/intl-tools`, its build-time tools. Read the root [README](README.md),
[CONTEXT.md](CONTEXT.md) for the domain language, and the affected package's README before changing
behavior.

## Package responsibilities

- `packages/intl` is the runtime: `<T>`, `useT`, `msg()`, `useFormat()` and the parser-free
  formatter that reads compiled catalogs, with one subpath per host (`/core`, `/react`, `/server`,
  `/next`, `/next/server`, `/start`). Public.
- `packages/intl-tools` is everything that runs at build time: the deny-by-default extractor, the
  `elmera-intl` CLI, PO catalogs and their compiler and loaders, the Vite and Next build plugins,
  the `elmera-intl/extractable` lint rule and the Vitest catalog check. Public.
- `packages/intl-e2e` holds the Next.js and TanStack Start fixture apps and their Playwright gates.
  Private; nothing depends on it, so its framework dependencies stay out of consumers' installs.
- `tooling/typescript` contains the shared TypeScript configuration.
- `tooling/lint` holds this workspace's own contracts as lint: the `elmera-workspace` oxlint plugin
  and the manifest test for what lives in JSON and YAML. Private.
- `scripts` contains workspace scripts: the PR title check and the release script
  (`scripts/release.ts`, run by `.github/workflows/publish-release.yml` and
  `version-packages.yml`, and by maintainers for `promote`).

Keep the dependency direction `intl-e2e` → `intl-tools` → `intl`
(`elmera-workspace/import-boundaries`). The tools reach the runtime's serializer, catalog codec and
formatter through its `/internal/*` subpaths. Both published packages are self-contained: they import
no other `@elmeragroup` package, so a consumer installs nothing else of ours.

## Setup and checks

Use the Node version in `.node-version` (also `devEngines.runtime` in `package.json`, which pnpm
downloads when it is missing) and the pnpm version in `packageManager`. Shared dependency versions
belong in the catalog in `pnpm-workspace.yaml`, pinned exactly; use `catalog:`, `catalog:react19` and
`workspace:*` references.

The workspace type-checks with `tsrs`, a Rust port of the TypeScript 7 compiler that follows
TypeScript 7.1. `typescript` stays installed for tsdown and the frameworks' own type generation.
Type-aware Oxlint runs on tsrs too. Lint and type-check read source, never `dist`: every
workspace export map has an `elmera-source` condition pointing at `src`, which `tooling/typescript`
enables for TypeScript and the lint script passes to Node (`--conditions=elmera-source`) for the
plugins Oxlint loads from source. Run Oxlint through `pnpm lint`, which sets that and
`OXLINT_TSGOLINT_PATH=node_modules/.bin/tsrs-lint`; neither needs a build. The e2e fixtures'
`type-check` drops the condition (`--customConditions null`) to read the built declarations, as
consumers do. Development needs macOS or Linux.

Run commands from the repository root unless stated otherwise.

```sh
pnpm install --frozen-lockfile
pnpm ci:checks     # format, lint, type-check and every package's tests (CI's checks job)
pnpm test:e2e      # fixture apps on linked, then packed, packages (CI's e2e job)
```

While iterating:

```sh
pnpm dev                                    # rebuild packages on change (turbo watch)
pnpm tcw                                    # type-check in watch mode
pnpm --filter @elmeragroup/intl test        # one package's tests in watch mode
pnpm turbo run test:run --filter=@elmeragroup/intl -- conformance   # one package, one file filter
pnpm bench                                  # runtime cost and client formatter size
```

Tests that read `dist` (public surface, the formatter as it ships) depend on `build` in the
package's `turbo.json`. Run them through turbo, as above, which builds first; `pnpm --filter`
skips the build and reads a stale `dist`. For documentation-only changes, check formatting with
`pnpm exec oxfmt --check <changed-files>`.

Report the checks run and any failures or checks you could not complete, as the gates in
[CONTRIBUTING.md](CONTRIBUTING.md#verification).

## Code conventions

Follow `.oxlintrc.json`, `.oxfmtrc.json` and the shared TypeScript configuration. Use strict types,
separate type imports and kebab-case filenames. Every configured rule is an error, never `warn`, and
every rule turned off carries a comment naming the contract it conflicts with (the manifest test
checks both). Use the formatter for layout and import ordering; lint enables no layout rule.

Fix the underlying issue before adding a lint exception. Every disable carries a `--` reason that
names the contract it guards (`elmera/require-disable-reason`), and lint reports unused disables as
errors. Use a `SAFETY:` comment where the assertion rule requires it. A file-scoped override in
`.oxlintrc.json` carries a comment that says why the file is the boundary that needs it.

There are no ADRs. A contract is enforced by a lint rule where lint can see it, because that is
the fastest feedback, and otherwise by a test; its rationale lives beside its owner in code. The
`elmera-workspace/*` rules in `tooling/lint` hold naming, the public surface, import boundaries,
global names and side-effect-free modules, each failing with its fix, and
`tooling/lint/test/workspace.test.ts` holds the manifests, the catalog and `.oxlintrc.json`. A new
contract gets a rule or a test there, not a paragraph here. Track unresolved work as GitHub issues,
never in a backlog file, and cite the issue where code points at open work.

## Tests

Every new or changed test passes the authoring gate in
[the test-audit skill](.agents/skills/test-audit/SKILL.md#authoring-gate), and its answers go in the
PR's Test value section. A fix gets a test only when one passes the gate.

Assert behavior against an independently defined oracle: next-intl's hand-written expected output,
`IntlMessageFormat` itself, a package's committed `test/public-surface.json`, a committed fixture,
or a value the test states for a reason it gives. A test that computes its expectation with the
code under test, or asserts what its own mock returns, is a tautology. A cross-check between two representations that
must agree names both: the unit under test and the oracle its output must reproduce.

A test that flakes is made deterministic or deleted in the same change, never rerun or retried;
Playwright runs with `retries: 0`. Wait on a condition or drive a fake clock; a timeout is only a
hang guard. Date tests run under a host time zone that differs from the configured one, so the
configured zone is proven to win.

Each kind of test lives with its owner:

- Runtime behavior: `packages/intl/test/*.test.{ts,tsx}`.
- next-intl conformance: `packages/intl/test/conformance/`, with its ledger in that directory's
  README. Port a case with its expected output verbatim; count every source case once.
- Type-level contracts: `packages/intl/test/types.tsx`, `@ts-expect-error` lines that the
  type-check runs and never executes.
- Tools behavior, the extraction ↔ runtime differential corpus, the serializer fuzz and the lint
  rule's RuleTester cases: `packages/intl-tools/test/`.
- The workspace's own lint rules (RuleTester cases) and manifest checks: `tooling/lint/test/`.
- Public surface and client bundle boundary: each package's `public-surface.test.ts` and
  `packages/intl/test/bundle-boundary.test.ts`, against the built packages.
- Host integration as consumers get it: `packages/intl-e2e`, whose script builds each fixture app on
  the linked packages, then on `pnpm pack` archives installed as real copies, and runs the
  Playwright specs in `tests/` against each build. A new host adapter or build plugin adds a
  fixture app there.

## Public behavior and releases

The two public packages version together, as one `fixed` group in `.changeset/config.json`, and
publish to npm from `main` through trusted publishing: canaries of pending changesets, and stable
versions through the Version Packages PR ([CONTRIBUTING.md](CONTRIBUTING.md#releases)). Each ships
its `LICENSE` and a `NOTICE` with the licenses of the third-party code in its `dist`, declarations
included: the runtime's covers next-intl's relative-time rules and intl-messageformat and its
`@formatjs` dependencies bundled into the formatter; the tools' covers the `@oxlint/plugins`,
`type-fest` and `@types/json-schema` declarations inlined into `dist/oxlint.d.ts`. Code copied or
bundled from another project gets an entry there (check the `//#region` paths in `dist` after a
dependency or bundling change), or beside the files when only tests carry it
(`test/conformance/LICENSE-next-intl`). Every runtime export is listed in its package's
`test/public-surface.json`, which lint checks against `src` and the public-surface test against the
built package; change both together. `/internal/*` exists for the tools and carries no semver
promise.

Bundle with tsdown and emit declarations from `src` only. Keep runtime dependencies pinned and few:
the browser-facing runtime ships no ICU parser, and G7 proves it.

## Adding a package

The workspace grows by package, not by folders inside one. A new workspace package:

1. Lives in `packages/<name>` (a library or test harness) or `tooling/<name>` (workspace tooling),
   with a kebab-case directory and an `@elmeragroup/<name>` name.
2. Extends a preset from `tooling/typescript` (`base.json`, `react-library.json`, `nextjs.json`,
   `internal-package.json`) and declares `tsrs` and `typescript` as `catalog:` dev dependencies.
3. Defines the scripts turbo runs, as applicable: `build`, `dev`, `type-check`, `tcw`, `test`,
   `test:run`, `ci:checks` (its type-check and tests), `e2e`, `bench`, `clean`. A task that needs
   different inputs or dependencies overrides it in the package's own `turbo.json`, which extends
   the root's and lists `^build` again.
4. Takes every dependency from the catalog. A new catalog entry is an exact version past
   `minimumReleaseAge`.
5. Maps every `exports` subpath to its source under the `elmera-source` condition, listed first.
6. If published: has `"sideEffects": false`, `types` first after the source condition, a `files`
   allowlist, a README, a `test/public-surface.json` and the test that reads it, a place in the
   changeset `fixed` group, and coverage in the e2e packed pass. The manifest test checks these.
7. Gets a line under [Package responsibilities](#package-responsibilities) and in the README.

## Task references

Before opening a PR, read [CONTRIBUTING.md](CONTRIBUTING.md) in full. Write the PR body from
[the PR template](.github/pull_request_template.md), filling each section and every Verification
row, in place of any generic summary format. Apply the `no-changeset` label when CONTRIBUTING.md's
release rule calls for it.

Change these instructions when durable working conventions change.
