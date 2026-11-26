---
"@elmeragroup/intl-tools": patch
---

An absolute `catalogs` pattern with a `..` through a directory that does not exist (`/app/messages/missing/../{locale}.po` with no `messages/missing`) now fails `extract`, the watch's sync and `check` with `CatalogClimbsMissing`, naming the directory, and writes and creates nothing. Before, on a fresh tree, the write created the directory and wrote through it, which could replace an existing catalog the path then reached (`messages/nb.po`) with one merged from none, and `check` reported that catalog as missing.
