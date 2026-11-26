---
"@elmeragroup/intl": minor
---

A report with no `onError` now reaches `console.error`, where it was dropped: a message not extracted yet, a message
that fails to format, a failed `format` call, or a `<T>` inside a `<T>` logs `@elmeragroup/intl: "<key>" <error>`,
once per distinct problem in a loaded copy of the runtime (past 1,000 distinct problems the record clears, so one may log again). This holds in production too, in the browser's console and
on the server's stderr, so an app with no `onError` now shows these lines to its users and in its server logs. What
renders and what throws are unchanged. To silence or route the reports, pass `onError` to `createIntl`,
`<IntlProvider>` (on Next, from a `"use client"` component that renders it), or `CurrentIntl.layer`/`CurrentIntl.provide`'s
options; an `onError` receives every report, as before, and nothing is logged. The server translator on Next takes its
handler from the request module, with the new second argument: `createRequestConfig(adapter, { onError })` (its options'
type, `RequestConfigOptions`, is exported from `@elmeragroup/intl/next/server`), and a hand-written `RequestConfig` may
return `onError` with the config.
