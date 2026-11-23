---
"@elmeragroup/intl-tools": patch
---

The Turbopack/webpack `*.po` loader no longer loads the extractor and its native oxc binding in each loader worker, so a worker starts faster; it compiles catalogs, and reports their errors, as before. The Vite plugin now runs its dev-server watch and its build check on an Effect runtime it owns for each dev server and each build, released when that server or build closes (for `vite build --watch`, when its watcher closes), so a server restart, a second server, or another build of the same plugin no longer stops a running watch. Its output and errors are unchanged.
