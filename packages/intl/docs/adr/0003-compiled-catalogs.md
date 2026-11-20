# 0003: Compiled per-locale catalogs, hashed keys, a compact IR, host loaders

Date: 2026-11-19. Status: accepted. Supersedes [ADR 0001](0001-build-only-inlined-messages.md).

## Context

> Written while this package lived in the monorepo of its first adopting apps: a Next.js host app and a TanStack Start host app, which ran next-intl and gt until they migrated. "Both apps", "main" and the routes named below are theirs; "the sales route" is the Next.js host app's largest dashboard route.

ADR 0001 inlined each call site's compiled messages, in every locale, into its module. Measured on the Next.js host app's sales routes (R1 and P0, gzip -9), that cannot fit: about 1,100 messages per dashboard route come from the shared dashboard shell, and inlining them per route, in four locales, puts the sales route 35 KB over the budget (10.8 KB calibrated and deduplicated). The transform was also where most review defects lived. Plain mode, the fallback, sent the request locale's whole catalog as AST values under English source keys (`no` 49,977 B, against next-intl's 42,139 B) and kept the ICU parser in the browser.

A council (three members, four rounds, R1 to R4) chose the shape below; the S0 spike built and measured it before this change.

## Decision

- **One compiler.** `compileCatalog(po, locale, { formats })` in `@elmeragroup/intl-tools/compile`, called by the Turbopack loader (`withIntl`), the Vite `load` hook (`intl()`, `intlCatalogs()`), `loadCatalog(path)` for Node, and `check`. Dev, build, tests and scripts compile alike, and nothing is written to disk: the PO is the only checked-in catalog.
- **Hashed wire keys.** An entry's key is `hashKey(keyOf(source, context))`: cyrb53, reduced to seven base-36 characters (36^7 ≈ 7.8e10, about 36 bits where the plan said "about 40"; by the birthday bound, 4e-5 collision odds for the Next.js host app's 2,502 keys, 6e-4 for 10,000). A collision fails the compiler and `check`; a context resolves it. The hash lives beside the serializer in `/internal/message`, so the extractor, the compiler and the runtime share one implementation, and a change to it bumps `SERIALIZER_VERSION`. The PO stays keyed by English source and context, for people.
- **A compact IR.** Literals are plain strings and a lone literal is the whole entry; structure is tuples tagged by the parser's element types (`[1, name]`, `[2, name, style?]`, `[6, name, arms, offset?]`, `[9, …]` for an ordinal, `[8, name, children]`, `0` for `#`). Plural offsets, skeletons as the parser produces them, named styles, the plain-text rule (a plain `{x}` takes text) and branch laziness survive; the request time zone stays a format setting. The catalog is `{ v: 1, m: { [hash]: IR }, e?: [hash] }`, versioned by `CATALOG_VERSION`; the runtime rejects another version. Its type `Catalog` is branded (type-only, so it crosses Flight and loader data as plain JSON): only `compileCatalog` makes one.
- **Complete catalogs, no separate English one.** A locale's catalog holds every key: its translation, or the compiled English source marked English (`e`), which formats in `en`. `en` compiles from the msgids and holds only structured entries. An entry whose rendering is its own source text is left out, by the runtime's own `isLiteralSource`, and the runtime renders a missing key's plain source as is.
- **A parser-free runtime, by construction.** `/internal/formatter` is intl-messageformat built with its parser replaced by `no-parser.js`; the runtime decodes entries lazily (once per catalog object) and formats them. A key the catalog lacks with ICU syntax (not extracted yet) renders its raw source, or `<T>`'s children, and calls `onError` with `MessageNotExtracted`. A format failure is a caller bug the types and `check` rule out: `onError`, then a throw.
- **The artifact is validated, not the parse.** Every entry is shipped through JSON, decoded and deep-compared with the parse, then dry-formatted from the decoded form through the runtime's `formatAst`, with the app's `formats`: every number, date and time node alone with every legal value type (number, `bigint`, `Date`), then a value per plural and select arm, derived from the locale's plural rules after the offset, skipping `=N` values, with a probe confirming the intended arm rendered. An arm no value reaches is listed with its reason (`category-absent`, `shadowed`, `not-sampled`) and never fails: the node pass already formatted its nodes. Only a probe that finds another arm rendered fails. English-marker entries validate in `en`.
- **Formats from one module.** `elmera-intl.json`'s `formats` names the module whose `formats` export the adapter imports and `check` and every loader load, so validation and runtime agree.
- **Hosts.** Next: `withIntl` appends a `*.po` rule (two, split on `?source`) scoped to the configured catalogs' paths, beside next-intl's. Vite: a `load` hook; in dev a PO save invalidates its modules in every environment and sends a custom event that `createCatalogReload(import.meta.hot)` (`/start`) turns into `router.invalidate()`. The listener registers at module level: registered from an effect, it never fired (S0). Node: `loadCatalog`. Types: `@elmeragroup/intl-tools/po`.

## Measured

R1 and P0 (sales routes, gzip -9): plain mode's AST catalog under source keys is 39,070 B for the 2,064 `no` PO messages, against 34,128 B as plain strings and 34,594 B as icu-minify IR. The council measured hashed keys against English source keys: Opus 38.3 vs 47.0 KB for `no` (7-character keys), Sol 47.6–49.6 vs 55.7–58.3 KB across the locales (6-character keys), Astra 40,323 vs 50,378 B (7-character keys; main sends 42.1 KB).

S0 (spike, full candidate catalogs: 2,502 Next.js host app keys in 4 locales, 377 TanStack Start host app keys; replacement builds, gzip -9, JS from the manifests plus the catalog payload):

| Measure                                     | Result                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Translated document vs main                 | +4.2 to +4.7 KB (en −26 KB; Start app en +0.07 KB)                       |
| The catalog itself vs next-intl's           | 2.5–2.8 KB smaller                                                       |
| The overage                                 | our runtime (+7.0–7.2 KB) beside next-intl's and gt's, which migrate out |
| next-intl's parser chunk (both sides)       | 12.1 KB                                                                  |
| Same output as next-intl, compiled catalogs | 0 of 3,157 messages differ                                               |
| Validation over the full catalogs           | decode = parse; 0 throws in about 3,540 dry-formats per locale           |
| Open tab after a PO-only save (Next, Start) | 125 ms, 140 ms                                                           |
| Packed tarballs                             | Node floor, Vite build, Vitest and the missing-PO failure all pass       |

Rule R2-3 puts +4.2 to +4.7 KB in its 0–5 KB band: reported to the owner, and the work continues; the stop rule (more than 5 KB over) is unchanged for the migration waves.

End state (both apps migrated, next-intl and gt deleted; production builds vs main, gzip -9, JS from the manifests plus the provider payload): the sales route +6.4 KB in no/sv/fi, two other routes +2.5 KB and +1.7 KB, en −22.8 to −27.6 KB; the Start app's measured route −43.4 KB (nb), −47.8 KB (en). The runtime swap saves 4.8 KB and the payload 4.4 KB; call sites grow 12.6 KB, carrying English source and `msg()` where next-intl's build left 6-character ids. The owner accepted the overage.

The runtime benchmark (`bench/runtime.ts`: 200 messages of four shapes over a compiled `nb` catalog, a fresh `IntlInstance` per request, Node 26.12.1, Apple silicon) measured a cold request at 1.26 ms (8.78 ms in ADR 0001, which parsed), a warm one at 0.193 ms (0.97 µs per message), and the parser-free formatter at 2,505 B min+gzip against 9,973 B with the parser.

## Rejected

- **Per-call-site inlining (ADR 0001).** Every locale's messages in every module that uses them: 35 KB over budget on the sales route, and the defect-prone transform.
- **Locale chunks** (inlining with per-module, per-locale chunks behind a Turbopack query rule; R1 probed it). The chunk arrives after hydration with React `use()`, every first client navigation shows a Suspense fallback, and the sales route would need about 270 locale chunks.
- **icu-minify** (next-intl HEAD's IR). About 1.9 KB less formatter, but it drops plural `offset` and has neither a `formats` merge nor time-zone handling: adopting it means vendoring and patching it. Our IR exists only in generated output, so it can change later.
- **Generated files** (a pre-step writing compiled catalogs). Every host and task (dev, build, type-check, test, lint) then needs that step ordered first, and a clean checkout or a dead watcher leaves them stale or missing. The loaders generate nothing.
- **Per-route catalogs** (each segment file wraps its output in a scope that merges its subset into a client store; a loader walks every segment's import graph). Built and measured: the sales route −2.8 KB vs main (no), +6.6 KB worse in en. Reverted: a wrapper and path literal in 49 route files, a 700-line import walker whose every miss renders English, and 0.3–4.9 KB on each client navigation. The owner chose the bytes over the boilerplate.
- **English source keys on the wire.** 8.7 KB more per `no` document than seven-character hashes, for keys only the runtime reads.

## Consequences

- Apps import `./intl/<locale>.po` (and `?source` for `en`); there is no committed JSON and no JSON-sync rule. A missing configured PO fails `check`, the build and the tests that import it.
- `createIntl` takes only a compiled catalog and has no compile option: tests and scripts compile through `loadCatalog`, `compileCatalog` or a Vite config with `intlCatalogs()`.
- A translation that would throw at runtime fails the build instead (check and the loaders dry-format it); one that slips through (an untyped caller) throws, since there is no English catalog to fall back to.
- Another IR remains possible under a new `CATALOG_VERSION`.
