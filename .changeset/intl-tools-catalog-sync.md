---
"@elmeragroup/intl-tools": patch
---

`extract`, `extract --watch` and the Vite dev watch do what they did, with one exception: a watch that fails while
recording what a sync wrote now reports a failed sync and keeps running, retrying on the next change, where it used to
stop. It reports `Failed` with one `SyncFailed` problem naming the error, not the sync's own problems, and a later
change to a catalog, the sync's own write included, starts another sync, which finds nothing to do once the files have
settled.
