---
"@elmeragroup/intl": patch
---

A `<T>` containing another `<T>` (the same loaded `T` function, at any depth) now reports to `onError` and renders
its children as written, the inner `<T>` translating itself, where it used to render a wrong translation silently
whenever the catalog had the outer message's key; keep the whole text in the outer `<T>`. The runtime does not catch
a wrapper component that renders a `<T>` (which extraction misses too), a second loaded copy of the package, or, in a
Next server component, a client-reference `<T>`, which it reads as a tag; and a server component has no `onError` to
report to (#100).
