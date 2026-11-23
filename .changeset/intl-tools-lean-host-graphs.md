---
"@elmeragroup/intl-tools": patch
---

The Turbopack/webpack `*.po` loader no longer loads the `elmera-intl` CLI, its commands and the watcher in each loader worker, and `withIntl` loads only the config reader into `next.config`, not the extractor and its native oxc binding. The Vitest global setup (`@elmeragroup/intl-tools/vitest`) now returns a Promise, which Vitest awaits; it fails the run with the same messages as before.
