# 0001: Build-only transform that inlines compiled messages

Date: 2026-11-18. Status: superseded by [ADR 0003](0003-compiled-catalogs.md) (2026-11-19): the optimizer is deleted.

## Context

> Written while this package lived in the monorepo of its first adopting apps (a Next.js host app and a TanStack Start host app), which also ran next-intl and gt during the migration; "both apps" and "these apps" are those two. Paths and package names are as they were then.

v0 sent each page its whole locale catalog (34-41 KB compressed once the Next.js host app is migrated) and compiled ICU at runtime in the browser, with `intl-messageformat`'s parser (9.9 KB gzip). v1 wanted production pages to carry only the messages they use, precompiled, without making any build step necessary for correctness: dev, tests, Storybook and scripts keep the plain runtime. Hosts in v1: Next 16 with Turbopack (a Next.js host app) and Vite with TanStack Start (a TanStack Start host app), both also running next-intl or gt, whose resolution and parsing we must not touch.

## Options

1. Per-route catalogs from the chunk graph. Rollup only: Turbopack runs loaders, not plugins, so Next could not have it.
2. Hashed keys and precompiled per-locale catalogs. Smaller keys and no parser, but still the whole catalog on every page.
3. A per-file `?intl` sidecar module. Per-route through code splitting, but two loaders parse the same file and couple by index, every PO write invalidates every sidecar in dev, and Turbopack needs a query rule that must not rerun the main transform.
4. A build-only transform that inlines each proven call site's compiled messages (every locale) into its own module.

## Decision

Option 4. Per-route falls out of the host's code splitting; one loader parses each file once; dev is untouched. The extractor that writes the catalogs also proves the rewrite sites, so the transform has no second walker, and a site it cannot prove in a layer without the catalog fails the build instead of skipping. The catalog is dropped where data leaves the server (`@elmeragroup/intl/internal/mode` aliased to the inlined mode, the provider halves hand the client `catalog: "inlined"`); the server keeps its catalog and parser. Only our own specifiers are aliased (`/internal/mode` everywhere, `/internal/formatter` to the parser-free `/internal/formatter-compiled` in the browser), so next-intl, gt and the apps' UI library keep theirs. Inlining every locale is the right trade below roughly six locales per app; both apps have at most four.

## Spike outcome

Both hosts kept the optimizer: every check of the kill criterion passed with controls (Next: `"use client"`/`"use server"` and server actions, every layer reaching the loader, mixed next-intl files, the browser-only alias, an RSC `msg()` descriptor translated on the client, SSR in `no` with no catalog in the flight data, `next dev` unaffected; Start: transform before Start's compiler, `createServerFn`, SSR in `nb` with no catalog in the root loader data, `vite dev` unaffected). One rule change: the Turbopack rule omits `as` and `type`. `as: "*.js"` renamed `"use client"` modules so their client references failed to resolve, and `type: "ecmascript"` lost the runtime's `"use client"` boundary; without them the loader's compiled JS keeps the source module's type. `{ not: "foreign" }` does not exclude the workspace-linked runtime, so the transform exempts the runtime's own modules in code. The fixtures live on in `packages/intl-e2e` as the plain and optimized gates.

## Measured

Runtime benchmark (`packages/intl/bench/runtime.ts`, 200 messages of four shapes, per-request `IntlInstance`, Apple silicon laptop, Node 26.12.1):

| Metric                                           | Value   |
| ------------------------------------------------ | ------- |
| Cold request, 200 messages                       | 8.78 ms |
| Warm request, 200 messages (median of 200)       | 0.24 ms |
| Warm, per message                                | 1.19 µs |
| `intl-messageformat` with its parser, min + gzip | 9973 B  |
| `formatter-compiled` (no parser), min + gzip     | 2505 B  |

Apps, production builds with the optimizer off (HEAD before this change) and on, measured in locale `no`/`nb` with a translation only the catalog holds (the route never renders it) as the probe:

| Route                                 | Measure                                       | Off       | On        |
| ------------------------------------- | --------------------------------------------- | --------- | --------- |
| Next.js host app, a dashboard route   | Probe in the flight data                      | yes       | no        |
|                                       | Server HTML (inline flight data)              | 747252 B  | 746316 B  |
|                                       | Of which flight data                          | 636180 B  | 635244 B  |
|                                       | Client JS loaded by the page, gzip            | 1153412 B | 1147308 B |
|                                       | Warm server render, median of 10 (2 runs avg) | 166 ms    | 170 ms    |
| TanStack Start host app, a list route | Probe in the root loader data                 | yes       | no        |
|                                       | Server HTML                                   | 169354 B  | 168889 B  |
|                                       | Of which inline scripts (loader data)         | 32830 B   | 32365 B   |
|                                       | Client JS loaded by the page, gzip            | 681722 B  | 674858 B  |
|                                       | Warm server render, median of 10 (1 run)      | 23 ms     | 18 ms     |

Probes: Next.js host app "Ikke gyldig sammen med valgte felter", TanStack Start host app "Påkrevd hvis sluttdato ikke er satt". Client JS is every `.js` response of a full page load, each gzipped, so it includes the shared framework chunks. The payload saving is small because each migrated route holds 17 (Next.js host app) and 4 (TanStack Start host app) messages; it grows with the catalog, while the JS saving (6-7 KB gzip, in line with the 7.5 KB the parser-free formatter saves in the benchmark) applies to every page that uses the runtime. Render times are noise at this size: the optimizer is not a server-CPU change, since the server keeps compiling unproven sites at first use and caches per process. The e2e specs passed the same in both modes (Next.js host app 58 passed, 2 skipped by their own conditions; TanStack Start host app 3 locale and 12 smoke specs passed, run through a local proxy to a server on another port because 3001 was taken).

## Consequences

- Correctness never depends on the build: an untransformed site that reaches the parser-free browser renders its source and calls `onError`, and the coverage rules make that a build error.
- A Next app takes three touches: `withIntl` outermost, `elmera-intl check && next build`, `elmera-intl extract --watch` beside `next dev`. Vite takes `intl({ optimize: true })`.
- next-intl and gt still ship their own ICU parsers to these apps; the parser-free claim is about this runtime only.
- Source-map chaining through the loader is covered by the transform's tests, not by the app builds.
