---
"@elmeragroup/intl-tools": patch
---

The `formats` module is evaluated only from exactly the text `check` and the loaders read: the evaluating Node takes that text on stdin and runs the module only when every load Node makes of it, which decides its format, read the same text (a partial save Node cannot load, or a module deleted before Node resolves it, is compared too). A module edited while it loads is read and evaluated again, three attempts in total; a retry that succeeds is memoized, and only valid formats ever are, so an edit saved and undone during a load, or an import fixed later, can no longer leave another result cached under the module's text. What remains on Node 24 and 25: the module's path swapped to another valid formats module and back within the microseconds between the CommonJS loader's own resolution and the check of it.
