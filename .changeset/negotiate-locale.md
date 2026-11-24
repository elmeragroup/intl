---
"@elmeragroup/intl": minor
"@elmeragroup/intl-tools": minor
---

`@elmeragroup/intl/core`: `negotiateLocale(acceptLanguage, locales, { aliases })`, the most preferred of an app's locales an Accept-Language header accepts (RFC 9110 §12.4.2 weights, RFC 4647 §3.4 lookup), written as in `locales`, or `undefined` for the app's default, with the `NegotiateLocaleOptions` type. Aliases (`{ no: "nb", nn: "nb" }`) are case-insensitive and checked along the lookup chain after the locales themselves. A range rejected with `q=0` excludes the locale it names on every path and its alias target only through an alias, so `nb-NO, nb;q=0` and, with those aliases and no `no` shipped, `nn, no;q=0` are not Bokmål, but `nb, no;q=0` is; `*` is the caller's default at any weight. A wrong configuration (an alias naming a locale not in the list, an alias that is not a concrete language range, two locales differing only in case) throws a `RangeError` on every call. The example apps negotiate with it in place of their own copies.
