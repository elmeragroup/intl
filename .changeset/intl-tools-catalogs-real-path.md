---
"@elmeragroup/intl-tools": patch
---

Catalogs reached through a link compile. A `*.po` import is a configured catalog when its file is one at the path the config names or at its real path, on Next and on Vite: the bundler hands over the file it resolved through its links, so catalogs named through a link inside the project (`intl-link -> intl`), or a config reached through a directory alias (`/tmp/…` for `/private/tmp/…` on macOS), failed with `… is not a configured catalog`. On Next, `withIntl` also builds the rule's path from the catalogs' real path below the root's, as Turbopack matches it, so it no longer refuses such catalogs as outside a root that holds them (before, the rule never matched either: `Unknown module type`). Catalogs written inside the root through a link out of it are left to Turbopack, which refuses such an import itself. A file that the catalogs of several locales link to is the catalog of none, as before.
