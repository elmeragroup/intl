<!--
Read CONTRIBUTING.md before opening a PR. Solve one problem per PR; drafts follow the same rules.
Write the PR title in plain language and Title Case, such as
"Keep The Count Plural When A Translation Reorders Its Arguments". See CONTRIBUTING.md#pr-title.
-->

## Problem

<!-- The problem in a sentence or two: what happens, what should happen, and how to reproduce it.
Link a related issue if there is one. -->

## Scope

<!-- Why this belongs in intl rather than a consuming app, and why in this package. See
CONTRIBUTING.md#placement. Name any related problem you left for a separate PR.
See CONTRIBUTING.md#one-problem. -->

## Change

<!-- How this fixes the problem. If it touches both the runtime and the tools, say why the same
fix needs each of them. -->

## Test value

<!-- The answers to the authoring gate in .agents/skills/test-audit/SKILL.md#authoring-gate:
every question for each added or changed test, or the gate's reason for adding none.
See CONTRIBUTING.md#test-value. -->

## Verification

<!-- One row per gate in CONTRIBUTING.md#verification. Every gate is either run, with its command
and the result you saw, or marked n/a with the reason the change cannot reach it. A gate the
change reaches that you could not run is "not run", with why. Do not delete rows. -->

| Gate                    | Command                                                             | Result |
| ----------------------- | ------------------------------------------------------------------- | ------ |
| G0 Reproduced           | <!-- the failing command or test, before the change -->             |        |
| G1 Static               | `pnpm format:check && pnpm lint && pnpm type-check`                 |        |
| G2 Behavior vs. oracle  | `pnpm test`                                                         |        |
| G3 Red before green     | <!-- the test, and the mutation that turned it red -->              |        |
| G4 Conformance ledger   | `pnpm turbo run test:run --filter=@elmeragroup/intl -- conformance` |        |
| G5 Extraction ↔ runtime | `pnpm turbo run test:run --filter=@elmeragroup/intl-tools`          |        |
| G6 Public surface       | `pnpm build && pnpm test`                                           |        |
| G7 Client bundle        | `pnpm turbo run test:run --filter=@elmeragroup/intl -- bundle`      |        |
| G8 Fixture apps (e2e)   | `pnpm test:e2e`                                                     |        |
| G9 Cost                 | `pnpm bench`                                                        |        |

<!-- Below the table: what each changed ledger row, public-surface entry or bench number means,
and anything you could not check. -->

## Release

<!-- What the changeset says ships in @elmeragroup/intl and @elmeragroup/intl-tools, and whether
the public surface changed (a semver decision), or why the PR carries the no-changeset label.
See CONTRIBUTING.md#release-impact. -->
