# Effect example

`@elmeragroup/intl/effect` on its own: an [Effect](https://effect.website) 4 HTTP API on Node, with no
React and no bundler, that answers in English (the source language), Norwegian Bokmål, Swedish and
Finnish. The API serves a power retailer's February invoices, the same domain and terms as the
[Next.js](../next-example) and [TanStack Start](../start-example) examples, which do not use Effect.

Node runs the source as written (`node src/main.ts`, types stripped), so every relative import names
its `.ts` file and the source holds only syntax Node can erase (`erasableSyntaxOnly`).

From the repository root, through turbo, which builds the packages the app links first (a fresh
checkout has no `dist`):

```sh
pnpm turbo run dev --filter=@elmeragroup/effect-example   # node --watch on :3032 (or PORT), restarted on a rebuild of the linked packages, with elmera-intl extract --watch
pnpm turbo run test:run --filter=@elmeragroup/effect-example   # check the catalogs, then the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/effect-example   # check, then start the server and test it over HTTP
```

Then ask it, in any of the four languages:

```sh
curl -H 'Accept-Language: nb-NO' 'http://127.0.0.1:3032/greeting?name=Ingrid'
# {"message":"Hei Ingrid, velkommen tilbake."}
curl 'http://127.0.0.1:3032/invoices/INV-2026-0217?lang=fi'
# {"id":"INV-2026-0217","customer":"Ingrid Berg","status":"Hyvitetty","amount":"−412,30 NOK",…}
```

| Endpoint                      | Answers                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `GET /greeting?name=…`        | `{ message }`: a greeting with the name in a placeholder                              |
| `GET /overdue?count=…`        | `{ message }`: how many invoices are overdue, in the language's plural forms          |
| `GET /invoices/:id`           | The invoice as text: label, amount, due date, period, delivery and age; 404 if absent |
| A request that does not parse | 400 `{ _tag: "InvalidRequest", message }`                                             |

Every endpoint answers in the request's language: the `lang` query parameter (`?lang=sv`), declared
on every endpoint so the OpenAPI document and a typed client name it, when it names a language the
API ships once, else the best of Accept-Language, else English. Every matched endpoint's response,
including its 400 and 404 errors, says which with `Content-Language`, adds `Accept-Language` to its
`Vary` (keeping any name already there, such as CORS's `Origin`; the `lang` parameter is in the URL,
which a cache already keys on) and sends `Cache-Control: private, no-store`. A path no endpoint
matches gets the router's bare 404 instead.

## Where each feature lives

| Feature                                                                                                                  | File                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| CLI config: sources, catalogs, locales, formats                                                                          | [elmera-intl.json](elmera-intl.json)                                                                                       |
| CLI scripts: `intl:extract`, `intl:check`, `extract --watch` beside `dev`, `check` before the HTTP tests                 | [package.json](package.json)                                                                                               |
| Catalogs: the POs translators edit                                                                                       | [src/intl/nb.po](src/intl/nb.po), [src/intl/sv.po](src/intl/sv.po), [src/intl/fi.po](src/intl/fi.po)                       |
| Catalogs compiled without a bundler: `loadCatalog` (`/compile`), all four once at start, a typed error if one fails      | [src/intl/catalogs.ts](src/intl/catalogs.ts)                                                                               |
| Named formats, shared by the runtime and `check`: a date, kroner                                                         | [src/intl/formats.ts](src/intl/formats.ts)                                                                                 |
| Locale negotiation: the `lang` parameter, then Accept-Language through `negotiateLocale` (`/core`)                       | [src/intl/locale.ts](src/intl/locale.ts), [test/locale.test.ts](test/locale.test.ts)                                       |
| `CurrentIntl.provide` per request, in an `HttpApiMiddleware`; `Content-Language`, `Vary`, `Cache-Control` on its answers | [src/intl/intl-middleware.ts](src/intl/intl-middleware.ts), [src/http-vary.ts](src/http-vary.ts)                           |
| A request that does not decode: effect's empty 400 answered with a sentence in the request's language                    | [src/intl/intl-middleware.ts](src/intl/intl-middleware.ts)                                                                 |
| The API's contract, schema first: endpoints, parameters, answers, errors, the middleware; importable alone (OpenAPI)     | [src/api.ts](src/api.ts), [src/invoice-number.ts](src/invoice-number.ts), [test/api.test.ts](test/api.test.ts)             |
| A generated client passes the invoice number an answer or a 404 names back to `GET /invoices/:id` (type-checked)         | [test/client.types.ts](test/client.types.ts)                                                                               |
| Handlers: `const { t, format } = yield* CurrentIntl`                                                                     | [src/handlers.ts](src/handlers.ts)                                                                                         |
| A placeholder                                                                                                            | [src/handlers.ts](src/handlers.ts) (`greeting`)                                                                            |
| An ICU plural, with `=0` and grouped counts                                                                              | [src/handlers.ts](src/handlers.ts) (`overdue`)                                                                             |
| A select                                                                                                                 | [src/handlers.ts](src/handlers.ts) (`invoice`: the delivery channel)                                                       |
| Formats in the configured zone, Europe/Oslo: currency, a date, a date range, a relative time with an explicit `now`      | [src/handlers.ts](src/handlers.ts) (`invoice`), [src/data/invoices.ts](src/data/invoices.ts) (`AS_OF`)                     |
| `msg()` descriptors declared at module scope, rendered with `t.from`                                                     | [src/intl/messages.ts](src/intl/messages.ts), [src/handlers.ts](src/handlers.ts)                                           |
| A typed error (`Schema.TaggedError`) mapped to a 404 body in the request's language                                      | [src/data/invoices.ts](src/data/invoices.ts), [src/api.ts](src/api.ts), [src/handlers.ts](src/handlers.ts)                 |
| Data with no English in it: statuses and channels are keys, instants are fixed                                           | [src/data/invoices.ts](src/data/invoices.ts)                                                                               |
| Expected client errors kept out of error reporting: `[ErrorReporter.ignore]` on `InvalidRequest` and `UnknownInvoice`    | [src/api.ts](src/api.ts)                                                                                                   |
| The app on a Node port: srvx's Node adapter and `HttpEffect.toWebHandler`; graceful shutdown with a deadline             | [src/node-listener.ts](src/node-listener.ts), [test/node-listener.test.ts](test/node-listener.test.ts)                     |
| The composition root (routes, middleware, router limits) over `Catalogs`; the entry point (`Catalogs.layer`, `PORT`)     | [src/server.ts](src/server.ts), [src/main.ts](src/main.ts)                                                                 |
| Vitest: the catalog check as a global setup; a start over a PO that does not compile; `Vary` with CORS, in process       | [vitest.config.ts](vitest.config.ts), [test/catalog.test.ts](test/catalog.test.ts), [test/vary.test.ts](test/vary.test.ts) |
| HTTP tests: the server as a process, every endpoint in all four languages; the expected text per locale                  | [tests/http.test.ts](tests/http.test.ts), [tests/expected-text.ts](tests/expected-text.ts)                                 |

## Not shown here

- React: `<T>`, `useT`, `useFormat`, `IntlProvider` and the host adapters (`/react`, `/server`,
  `/next`, `/start`), which the [Next.js](../next-example) and [TanStack Start](../start-example)
  examples show.
- A build plugin: no bundler compiles a `*.po` import here; `loadCatalog` compiles each PO at start.
- `keyOf`, `serialize` and `SERIALIZER_VERSION` (`/core`), which the runtime and the tools compute for
  the app, and `createLocaleSwitcher` (`/core`), a browser's locale switch.

## Notes

- **The translator is per request, never a shared layer.** `CurrentIntl.provide(options)` runs the
  options effect each time an endpoint's effect runs, so each request gets the translator for its
  own locale. A layer is built once, and would hand every request the first one's locale:
  `CurrentIntl.layer` is for a fixed locale, a test's or a one-locale job's, which this API has none
  of.
- **The middleware wraps the request's decoding too.** effect decodes an endpoint's path, query and
  headers inside the middleware's effect, so a request that does not decode fails where
  `CurrentIntl` is already provided, and its 400 is in the request's language. A path no endpoint
  matches is the router's 404, before any middleware, with an empty body and no `Content-Language`.
  The router takes a path parameter as long as Node lets a request's head be (`http.maxHeaderSize`,
  which `--max-http-header-size` sets), not its default 100 characters, so an overlong invoice number
  is a malformed one, the same localized 400, rather than that bare 404; and it collapses duplicate
  slashes, its default, so `//greeting` is `/greeting`.
- **Catalogs load once, at start.** `Catalogs.layer` compiles four catalogs from three PO files when
  the server starts: English is the source, so its catalog is `nb.po`'s msgids, compiled for `en`,
  beside Bokmål, Swedish and Finnish from `nb.po`, `sv.po` and `fi.po`. A catalog that does not
  compile fails the start with `elmera-intl check`'s report, naming its locale, before the port opens
  (the catalog test holds it), and no request waits on a compile.
- **`@elmeragroup/intl-tools` is a dependency here,** not a devDependency as in the host examples:
  without a bundler, the server itself compiles the POs with its `loadCatalog`.
- **The contract imports nothing it does not declare.** [src/api.ts](src/api.ts) holds the
  endpoints, their schemas, the errors and the middleware's declaration. It and the one module of its
  own it imports, [the invoice number](src/invoice-number.ts), take only effect's schema and HTTP API
  modules and the runtime's `/effect` subpath, as types; lint reports any other import or re-export
  (`.oxlintrc.json`), a value import from `/effect`, a Node module, effect's Node platform, srvx, the
  catalog loader, the locale negotiation, data or the server, so a client or a docs build takes the
  contract alone. The `lang` parameter's name is declared there, beside the query schema that
  takes it, and the middleware reads it from there. An answer writes an invoice's
  number with the same `InvoiceNumber` schema its path decodes, so a generated client passes it back
  as it is. [src/server.ts](src/server.ts) wires the middleware's implementation and requires the
  catalogs, which [src/main.ts](src/main.ts) provides.
- **Effect's Node server is not used.** It lives in `@effect/platform-node`, which this workspace
  does not install (its required redis peer auto-installs 15 MB). `@effect/platform-node-shared`
  provides the process runner, `NodeRuntime.runMain`, but no HTTP server, so
  [src/node-listener.ts](src/node-listener.ts) serves `HttpEffect.toWebHandler(app)` with
  [srvx](https://srvx.h3.dev)'s Node adapter: a client that disconnects aborts the request's signal,
  which interrupts its handler, and a body no route reads never holds up a keep-alive connection.
  Shutdown (SIGINT or SIGTERM, through the Effect scope) stops listening and lets the responses in
  flight finish, closing each connection once it is idle and the ones still open after 10 seconds (the
  listener test holds a response in flight across the close).
- **Relative times take an explicit `now`.** The API's moment is fixed (`AS_OF` in
  [src/data/invoices.ts](src/data/invoices.ts)) so every answer and the tests agree; an API passes
  its clock's.
- **Dates are Oslo's, wherever the server runs.** The HTTP tests start the server in New York, where
  the invoices' due date, midnight on 20 March in Oslo, is still 19 March.
- **The HTTP tests start the process, not the module.** Vitest's transform would accept what Node's
  type stripping refuses (an import without its `.ts`, syntax Node cannot erase), so only
  `node src/main.ts` proves the API runs as written. They are the app's `e2e`, as the host examples'
  Playwright specs are theirs; `PORT=0` takes a free port, which the server's log line names.
- **Lint.** The workspace's `.oxlintrc.json` already runs `elmera-intl/extractable` here, and
  `pnpm lint:effect` the Effect diagnostics. In an app of your own:

  ```json
  {
    "jsPlugins": [{ "name": "elmera-intl", "specifier": "@elmeragroup/intl-tools/oxlint" }],
    "rules": { "elmera-intl/extractable": "error" }
  }
  ```

- **Type-check** reads the packages' built declarations (`tsrs --noEmit --customConditions null`)
  under Node's own resolution (`--module NodeNext --moduleResolution NodeNext`), as an app installing
  them from npm and running unbundled does. The tsconfig keeps the workspace's Bundler resolution for
  the editor and lint, which read the packages' source.
