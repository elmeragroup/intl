---
"@elmeragroup/intl": patch
---

`LocaleSwitch` from `/next` and `/start` is now declared as a mapped type over one shared shape. The type is
equivalent, so a package that exports an inferred wrapper of `useLocaleSwitch` needs no change: its declarations still
name `import("@elmeragroup/intl/next").LocaleSwitch` or `import("@elmeragroup/intl/start").LocaleSwitch` (#60).
