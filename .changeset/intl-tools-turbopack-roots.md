---
"@elmeragroup/intl-tools": patch
---

On Next, a catalog import whose `elmera-intl.json`, or formats module, lies outside Turbopack's root and its
`experimental.turbopackAdditionalRoots` now fails with the loader's own problem: which file is outside which root, and
the fix (widen `outputFileTracingRoot` when set, else `turbopack.root`, or list a directory that holds the file, and
neither holds nor lies in the root, as an additional root). Before, it failed with Turbopack's `webpack loader path …
is outside configured roots`, in place of the import's own outcome. The loader checks this only where Turbopack
compiles an import, so `next start` and a production custom server are unaffected (the production phase compiles
nothing, and `withIntl` reads nothing there), and not at all when an adapter is selected.
`withIntl`'s check of catalogs outside the root now names `outputFileTracingRoot` when that setting decides the root.
