---
"@elmeragroup/intl-tools": patch
---

The Turbopack/webpack `*.po` loader no longer loads the extractor and its native oxc binding in each loader worker, so a worker starts faster; it compiles catalogs, and reports their errors, as before. The Vite plugin now runs its dev-server watch and its build check on an Effect runtime it owns for each plugin instance, disposed when the bundle closes (for `vite build --watch`, when its watcher closes) or when the dev watch fails to start. Its output and errors are unchanged.
