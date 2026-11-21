---
"@elmeragroup/intl-tools": patch
"@elmeragroup/intl": patch
---

The PO reader and writer are now `@elmeragroup/intl-tools`' own Effect `Schema` codec, replacing the `po-parser` dependency with `effect` (4.1.3). Catalogs read and write as before: the same GNU msgcat reading, held by po-parser 2.2.0's ported test suite and its recorded output (`test/po-conformance`).
