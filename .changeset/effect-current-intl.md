---
"@elmeragroup/intl": minor
"@elmeragroup/intl-tools": minor
---

`@elmeragroup/intl/effect`: `CurrentIntl`, the translator as an Effect service (`const { t } = yield* CurrentIntl`), provided per request by `CurrentIntl.provide(options)` or once by `CurrentIntl.layer(options)`, with `effect` (`^4.1.3`) as an optional peer. The extractor and the `elmera-intl/extractable` lint rule read `yield* CurrentIntl` as a bound IntlInstance and reject any other read of the service.
