---
"@elmeragroup/intl-tools": patch
---

The config refuses catalog paths that two locales could share, as `ConfigInvalid` in every host: a locale that is not an identifier `Intl.getCanonicalLocales` accepts (a path such as `/nb` or `../messages/nb` named another locale's catalog), two locales that are one identifier (`nb` and `NB`, `iw` and `he`), and a `catalogs` pattern with a `..` segment anywhere after the first segment holding `{locale}` (`messages/{locale}/../catalog.po`), where a directory the sync created for one locale made its path reach the catalog another locale had just written and `extract` replaced its translations. A `..` before `{locale}` stays valid.
