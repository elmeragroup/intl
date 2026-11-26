---
"@elmeragroup/intl-tools": patch
---

`intlCatalogs()` (and `intl()`, which includes it) keeps compiled catalogs out of Vitest 5's file-system module cache,
so a Vitest watch rerun, or the next `vitest run`, after an edit of `elmera-intl.json` or of its formats module compiles
the catalog again instead of reusing the old one. The cache keys a module by its own bytes, which such an edit leaves
as they were. Every other module keeps the cache.
