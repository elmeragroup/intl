// `@elmeragroup/intl/internal/request-config` under the `react-server` condition: the request config of server
// components, server actions and route handlers, which is the app's request module. A host's build plugin aliases
// `@elmeragroup/intl/internal/request-module` to that module (Next: `withIntl` points it at `./intl/request.ts`); only
// this module imports that specifier, so only the react-server layer can bundle the app's adapter. Client and SSR code
// resolve `internal/request-config` to the stub, whose error names the cause.
//
// The package's own specifier, not `./request-config`: it stays an import in the build (tsdown's `neverBundle`), so the
// host's bundler can alias it. A relative import would be bundled in, and the stub would always win.
export { default } from "@elmeragroup/intl/internal/request-module";
