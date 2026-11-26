---
"@elmeragroup/intl-tools": minor
---

`withIntl` now returns Next's phase function, `(phase) => config`, in place of the config, and refuses a project it cannot read only in the phases that compile through Turbopack: `next build` and `next typegen`, `next dev` and a dev custom server, and `next analyze`. There the refusals and their messages are as before. Every other phase compiles nothing, so there `withIntl` reads nothing and returns the config as passed, the very object: `next start` and a production custom server do not read the project, so a pruned deployment starts without `elmera-intl.json` or its source, or as a user who cannot read them, and with catalogs that lie outside the root Next detects there (before, `next start` exited with `withIntl: the catalogs … are outside the Turbopack root …`).

`export default withIntl(config, options)` in `next.config.ts` is unchanged. Code that read the result as a config changes:

- a config that is itself a phase function calls the result inside it: `export default async (phase, context) => withIntl(await config(phase, context), options)(phase)`;
- a wrapper applied outside `withIntl` (`withMDX(withIntl(config, options))`) moves inside it (`withIntl(withMDX(config), options)`), as the README already asked: it would now get a function;
- a test or tool that reads the rule or alias calls the result with a phase, such as `withIntl(config, options)("phase-production-build")`.

A `turbopack.resolveAlias` entry mapping the request module to `withIntl`'s own target is now refused like any other: it was allowed for a config wrapped twice, which a function result rules out. Remove it and set the `request` option.
