---
"@elmeragroup/intl-tools": patch
---

`extract --watch` and the Vite dev watch keep, for every catalog path, its own text after each clean sync: the plan's snapshot or what the sync wrote there, and, when it wrote anything, what the path reads back right after the writes if that is a text of the sync's own for it (the write guard's own rule). A catalog change is the watch's own write only when its path reads exactly that record. Locales whose catalogs are symbolic or hard links to one file no longer start a sync on every debounce; a catalog copied onto another, even between the writes and the read-back, syncs; and after a sync that ends with a problem or fails, any change to a catalog syncs again, so restoring a broken catalog recovers. When two catalogs' snapshots are one text, a copy between them during the sync still reads as the watch's own write, as it does for the write guard.
