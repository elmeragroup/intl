---
"@elmeragroup/intl-tools": patch
---

A PO file that the catalogs of two configured locales resolve to is refused for each of them, also when one of them names it as written: with `locales/sv -> nb`, the import of `sv`'s catalog, which the bundler hands over at `locales/nb/messages.po`, compiled for `nb` with no error. Now the imports of both `nb` and `sv` fail with `… is the catalog of nb, sv through a link; each locale needs a PO of its own`, which names the locales. Each catalog import now resolves the file and every configured locale's catalog through their links. Upgrading: locales that share one PO through a link need a PO each, and with them sharing one, the build fails for every locale that shares it, not only the linked one.
