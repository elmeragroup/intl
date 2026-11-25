# Intl

Source-keyed internationalization for React apps: code is written in English, a build step extracts
and compiles the messages, and a parser-free runtime formats them per locale.

## Language

**Source**:
The English text of a message as written in code, after whitespace collapses and elements become
positional tags (`<x0>`). With an optional context, it is the message's identity.
_Avoid_: key, id, message id

**Context**:
A literal string that tells two messages with the same source apart.

**Key**:
The serialized source plus context, as the PO file lists it for translators.
_Avoid_: id

**Wire key**:
The short hash of the key that a compiled catalog is indexed by and the runtime computes per call.
A serializer or hash change bumps `SERIALIZER_VERSION`.
_Avoid_: key, id

**Extraction**:
Reading messages out of source files. Deny-by-default: in a file that imports the runtime, only the
documented forms are allowed, and anything else fails extraction and lint, naming the fix.

**Residual**:
A form the extraction contract knowingly does not catch, listed with the reason it is left.

**Catalog**:
One locale's translations: a PO file, written by `elmera-intl extract` and edited by translators.
_Avoid_: messages file, dictionary

**Compiled catalog**:
A catalog after the compiler has parsed every ICU message into the runtime's IR and keyed it by
wire key. Only a compiled catalog reaches the runtime, which has no ICU parser.
_Avoid_: bundle, JSON messages

**Check**:
`elmera-intl check`: proves the catalogs are in sync with the source and that every message compiles
and dry-formats with the app's formats.

**Host**:
The framework an app runs on (Next.js, TanStack Start). Each host has one subpath adapter in the
runtime and one build plugin in the tools.
_Avoid_: platform, integration

**CurrentIntl**:
The Effect service `@elmeragroup/intl/effect` exports: its value is the request's or job's `IntlInstance`, read with
`const { t } = yield* CurrentIntl` and provided per request by `CurrentIntl.provide(options)` or once by
`CurrentIntl.layer(options)`.
_Avoid_: Intl (it shadows the global), translator service

**Fixture app**:
A minimal app per host in `packages/intl-e2e`, built and driven by Playwright to prove the packages
work as a consumer gets them.

**Example app**:
An app per host in `apps/` that shows the recommended setup of both packages, for readers to copy.
Its Playwright specs prove it works on its production build; the fixture apps, not the examples, are
the packages' test corpus.
_Avoid_: demo, sample, playground

**Linked pass / packed pass**:
The two ways a fixture app consumes the packages: through workspace links, or from `pnpm pack`
archives installed as real copies, as npm users get them.

**Oracle**:
The independently defined expectation a test reproduces, such as next-intl's expected output or
`IntlMessageFormat` itself.

**Deliberate difference**:
A conformance case where the runtime's output differs from next-intl's on purpose; the ledger names
both outputs.
_Avoid_: deviation, known bug

**Gate**:
One rung of the verification ladder in CONTRIBUTING.md (G0–G9), recorded per PR as run, n/a or not
run.
