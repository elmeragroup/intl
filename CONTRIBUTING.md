# Contributing

This workspace holds `@elmeragroup/intl`, Elmera Group's source-keyed i18n for React, and
`@elmeragroup/intl-tools`, its build-time tools. Before opening a PR, establish where the change
belongs and complete the review and verification below.

These rules apply to every PR, including drafts. A PR into `main` needs no formal approval, but only
a code owner listed in [CODEOWNERS](.github/CODEOWNERS) may merge it; branch protection enforces
this. Meeting this guide makes a PR eligible for merge. The code owner decides whether to merge it.

## Setup and workflow

Follow [Development](README.md#development) to set up the workspace. Read [AGENTS.md](AGENTS.md)
for the package responsibilities, code conventions and checks.

<a id="placement"></a>

## Ask first: intl or the consuming app?

Before adding an API, option, format, lint rule or host adapter, ask: "Does this belong in intl, or
in the app that needs it?" Add it here when it is i18n behavior that more than one app needs, or a
general gap a migrating app would otherwise work around: a next-intl behavior with no equivalent, a
host framework with no adapter, an extraction case the deny-by-default contract rejects for no
reason. Keep copy, catalogs and formats that belong to one app in that app.

Then place it in the package that owns it under the
[package responsibilities](AGENTS.md#package-responsibilities). The PR explains both decisions. A new
public export also names the general need it serves, since every export is a semver promise.

<a id="one-problem"></a>

## Solve one problem per PR

Split a PR that solves several independent problems, even when each fix is useful on its own. Count
the underlying problems, not the linked issues.

Include the source, tests, fixtures, ledger rows, documentation and changeset the problem requires.
Put unrelated cleanup and other fixes in separate PRs.

<a id="pr-title"></a>

## Title the PR in Title Case

Write the PR title as a plain-language sentence in Title Case: capitalize every word, and keep code
names and brand names in their own casing, such as "Format `dateTimeRange` In The Configured Time
Zone". Wrap an all-lowercase code or brand name in backticks. Leave out the conventional commit
prefix.

`main` accepts squash merges only. The PR title becomes the squash commit subject and the PR body its
description. The `pr-title` check flags titles that break the rule. Commit messages on the branch
keep the conventional commit format.

<a id="review-before-submitting"></a>

## Review it before you open it

Complete a full review pass before opening a PR, or before marking a draft ready for review. Review
bot-created release and dependency PRs before merging them; the code owner who merges one records
that review in a PR comment.

Use a reviewer other than the code's author: another person, or an agent with a fresh context. When
an agent wrote the change, the person who directed it can review it. The reviewer checks the complete
proposed diff and relevant surrounding code against the agreed scope, this guide and
[AGENTS.md](AGENTS.md), each Test value answer against its test, as the
[test-audit skill](.agents/skills/test-audit/SKILL.md) reviews, and each Verification row against
the gate it claims.

<a id="verification"></a>

## Show that it works

A PR proves its change through a fixed ladder of gates. The PR template lists every gate as a row,
and each row is filled in one of three ways:

- **Run**: the exact command, and the result you saw (counts, not "passes").
- **n/a**: the reason the change cannot reach what the gate guards, such as "docs only" for G4–G9.
- **Not run**: the change reaches the gate but you could not run it, and why. A code owner decides
  whether that blocks the merge.

A row is never deleted or left blank. CI runs G1, G2 and G4–G8 on every PR; the PR still records
them, because the row says what the result means for this change, which CI cannot.

| Gate                        | Required when the change touches                                    | What it proves                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0 Reproduced**           | any behavior fix                                                    | The problem exists: a failing test or command on the pre-change code, quoted.                                                                                                                                                                                                                        |
| **G1 Static**               | any code                                                            | Format, lint (with `--deny-warnings`) and type-check pass. Type-level contracts are `@ts-expect-error` lines in `test/types.tsx`, so a type check that stops failing fails the gate.                                                                                                                 |
| **G2 Behavior vs. oracle**  | any code                                                            | Every test asserts against an independent oracle (see [AGENTS.md](AGENTS.md#tests)). Each added or changed test names its unit under test and its oracle.                                                                                                                                            |
| **G3 Red before green**     | any added or changed test                                           | The test fails on the pre-change code, or under a deliberate mutation of the owner, for the reason it claims, and passes after. Record the mutation, then restore the source byte for byte.                                                                                                          |
| **G4 Conformance ledger**   | message formatting, the formatter, `<T>`, `useT`, `useFormat`       | next-intl's own tests, ported with their expected output verbatim, still pass. In `packages/intl/test/conformance/README.md`, every source case is counted once, and ported + deliberate difference + excluded equals the case count. A new deliberate difference names next-intl's output and ours. |
| **G5 Extraction ↔ runtime** | the extractor, serializer, catalog compiler, PO handling, lint rule | The differential corpus extracts and renders the same source, so the extracted key and the key the runtime looks up cannot drift apart. The serializer fuzz formats every short ICU-syntax text back to itself through `IntlMessageFormat`. RuleTester cases cover the lint rule.                    |
| **G6 Public surface**       | an export, a subpath, `package.json` `exports` or `files`           | The built packages, resolved by Node through their export maps, expose exactly the surface in `packages/intl/docs/adr/0002-naming.md`. A change to either changes both, and the Release section states the semver decision.                                                                          |
| **G7 Client bundle**        | any runtime module, or a new import in one                          | The client entry, bundled for the browser, pulls in no tools module (parser, PO, filesystem) through any chain of imports.                                                                                                                                                                           |
| **G8 Fixture apps (e2e)**   | runtime, tools, a host adapter, a build plugin, packaging           | The Next.js and TanStack Start fixture apps build and pass their Playwright gates twice: on the workspace-linked packages, and on the packed archives installed as real copies, as npm users get them. The linked pass also runs the dev servers and proves a missing PO file fails each build.      |
| **G9 Cost**                 | the runtime's formatting path, the client formatter, catalog shape  | Per-request translation cost and the client formatter's gzipped size, before and after. Explain any regression.                                                                                                                                                                                      |

When a change touches the e2e fixtures themselves, G8 also shows the gate going red: break the
behavior the new or changed spec guards, run the pass, and quote the failure.

<a id="test-value"></a>

### Test value

The [authoring gate](.agents/skills/test-audit/SKILL.md#authoring-gate) decides whether a change gets
a test. Every added or changed test answers each gate question in the PR's Test value section. A
behavior change without a new test names the gate's reason instead.

<a id="release-impact"></a>

## Declare the release impact

`@elmeragroup/intl` and `@elmeragroup/intl-tools` are the published packages, and they version
together. Add a changeset with `pnpm changeset` for any change that ships in either. Otherwise apply
the `no-changeset` label and give the reason in the PR. CI's changeset-presence check honours the
label.

A change to the public surface (G6) is a semver decision: say in the Release section whether it is
additive, a rename or a removal. `/internal/*` subpaths carry no semver promise.

Edit an existing changeset only to correct what it says shipped, never to move a gate.

## Merging and closing

Before merging, a code owner checks the problem, where the change lives, the scope and every
Verification row.

A code owner may close a PR or request changes when it belongs in a consuming app, solves several
independent problems, lacks a completed review or lacks evidence. The closing comment names the rule
and explains what would change the outcome.

Address the reason and reopen the PR, or open focused replacement PRs and link them to the original.
