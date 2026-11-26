---
"@elmeragroup/intl-tools": patch
---

Catalogs reached through a link per locale compile on Next. `withIntl` resolved the catalogs pattern before a locale was substituted into it, so a link at or below `{locale}` was not followed: with `locales/nb` a link to `translations/nb-NO`, the rule matched `locales/…/messages.po` while Turbopack matched the catalog at its real path, and the import failed with `Unknown module type`; with the catalogs written outside the root and each locale's directory a link into it, `withIntl` refused them as outside a root that holds them. Each configured locale's catalog whose real path the pattern misses is now matched there as well, and the root check is made per locale. When no locale's catalog lies elsewhere, the rule is the same as before. next.config is read once, so a locale added behind a link while `next dev` runs needs a restart.
