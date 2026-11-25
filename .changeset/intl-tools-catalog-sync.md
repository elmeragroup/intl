---
"@elmeragroup/intl-tools": patch
---

`extract`, `extract --watch` and the Vite dev watch do what they did, with one exception: a watch (the CLI's or
Vite's) that fails while recording what a sync wrote now reports `Failed` with one `SyncFailed` problem naming the
error, and stays running, where it used to stop. The next relevant change starts another sync, a change to a catalog
that sync already wrote included.
