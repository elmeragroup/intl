---
"@elmeragroup/intl-tools": patch
---

During `vite dev`, an imported catalog compiles again when `elmera-intl.json` changes. On Next, the loader now
registers `elmera-intl.json` as a dependency of an import that fails on the config or on a PO of no configured locale.
A PO of no configured locale fails with one text on both hosts: Next's swaps the absolute path for the path relative to
the config, and Vite's gains the `elmera-intl:` prefix.
