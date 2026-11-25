---
"@elmeragroup/intl-tools": patch
---

Where Turbopack compiles, `withIntl` fails at config time, naming the file and the setting to widen, when
`elmera-intl.json` or the formats module it names lies outside Turbopack's root and its
`experimental.turbopackAdditionalRoots`. Before, a catalog import failed with Turbopack's `webpack loader path … is
outside configured roots`, in place of the import's own outcome. These placement checks, and the catalogs check, run
only in Next's CLI running `next build` (without `--webpack`, in no `generate` or `generate-env` mode) and in the
`next dev` child or a dev custom server, with `TURBOPACK` set, Rspack not selected and no adapter selected
(`adapterPath`, `experimental.adapterPath` or `NEXT_ADAPTER_PATH`). Every other process skips them, so `next start`, a
production custom server or `next typegen` on a deployment copied without its workspace marker, where Next detects a
smaller root, no longer refuses catalogs above the app.
