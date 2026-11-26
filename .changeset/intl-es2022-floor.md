---
"@elmeragroup/intl": patch
---

A plural message no longer throws a `TypeError` on an engine without `Array.prototype.toSorted` (ES2023), and keys
as before. The runtime's own source now calls no built-in later than ES2022, its build target, and its type-check and
lint hold it there; the README's "Engines" section states that floor and what neither gate covers.
