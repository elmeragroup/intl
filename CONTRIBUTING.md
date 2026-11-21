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

| Gate                        | Required when the change touches                                    | What it proves                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **G0 Reproduced**           | any behavior fix                                                    | The problem exists: a failing test or command on the pre-change code, quoted.                                                                                                                                                                                                                                |
| **G1 Static**               | any code                                                            | Format, lint (with `--deny-warnings`) and type-check pass. Type-level contracts are `@ts-expect-error` lines in `test/types.tsx`, so a type check that stops failing fails the gate.                                                                                                                         |
| **G2 Behavior vs. oracle**  | any code                                                            | Every test asserts against an independent oracle (see [AGENTS.md](AGENTS.md#tests)). Each added or changed test names its unit under test and its oracle.                                                                                                                                                    |
| **G3 Red before green**     | any added or changed test                                           | The test fails on the pre-change code, or under a deliberate mutation of the owner, for the reason it claims, and passes after. Record the mutation, then restore the source byte for byte.                                                                                                                  |
| **G4 Conformance ledger**   | message formatting, the formatter, `<T>`, `useT`, `useFormat`       | next-intl's own tests, ported with their expected output verbatim, still pass. In `packages/intl/test/conformance/README.md`, every source case is counted once, and ported + deliberate difference + excluded equals the case count. A new deliberate difference names next-intl's output and ours.         |
| **G5 Extraction ↔ runtime** | the extractor, serializer, catalog compiler, PO handling, lint rule | The differential corpus extracts and renders the same source, so the extracted key and the key the runtime looks up cannot drift apart. The serializer fuzz formats every short ICU-syntax text back to itself through `IntlMessageFormat`. RuleTester cases cover the lint rule.                            |
| **G6 Public surface**       | an export, a subpath, `package.json` `exports` or `files`           | Each package's source (lint, `elmera-workspace/public-surface`) and its built package, resolved by Node through its export map (the public-surface test), expose exactly the surface in its `test/public-surface.json`. A change to either changes both, and the Release section states the semver decision. |
| **G7 Client bundle**        | any runtime module, or a new import in one                          | The client entry, bundled for the browser, pulls in no tools module (parser, PO, filesystem) through any chain of imports.                                                                                                                                                                                   |
| **G8 Fixture apps (e2e)**   | runtime, tools, a host adapter, a build plugin, packaging           | The Next.js and TanStack Start fixture apps build and pass their Playwright gates twice: on the workspace-linked packages, and on the packed archives installed as real copies, as npm users get them. The linked pass also runs the dev servers and proves a missing PO file fails each build.              |
| **G9 Cost**                 | the runtime's formatting path, the client formatter, catalog shape  | Per-request translation cost and the client formatter's gzipped size, before and after. Explain any regression.                                                                                                                                                                                              |

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

<a id="releases"></a>

## Releases

A push to `main` runs **Merge**. When its `checks` and `e2e` jobs pass, it calls two workflows for
the checked commit. Pull requests never publish.

- **Publish Release** (`publish-release.yml`, in the `npm` environment) runs `scripts/release.ts`,
  which picks the channel from the checked commit, in this order:
  - **stable**: the commit raised the packages' version over `HEAD^` (semver order). Only the merged
    Version Packages PR does that. The job publishes that version and creates the GitHub release
    `v<version>` at the commit, with links to both packages' changelogs at that tag. It refuses, and
    fails the job, in two cases:
    - **Changesets still plan a bump.** The release PR was merged while behind `main`, so its version
      can be too low, such as a patch that contains a breaking change. Nothing is published. The
      Version Packages job on the same push regenerates the release PR from the pending changesets;
      merge that PR to release.
    - **The commit lowers the version**, as a revert of a version commit does. npm never takes a
      version twice, and the revert also restores the released changesets, so the next release
      would plan the same version again. To undo a release, revert its code in an ordinary PR with
      a changeset, never the version commit. After a reverted version commit has landed, release
      forward in one commit: revert the revert (it restores the released version and drops the
      restored changesets) and add a changeset for the fix. The stable job refuses that commit as
      a stale release, and the Version Packages PR it regenerates releases the next version.
      Until then, merges publish canaries planned from the lowered version. This includes a
      revert of the first version commit back to `0.0.0`: only the commit that adds the packages,
      whose parent has neither manifest, skips the comparison.
  - **canary**: off until the packages are ready
    ([#4](https://github.com/elmeragroup/intl/issues/4)): the job prepares the canary as below, then
    skips Build and Publish with a notice. When on, it runs when the pending changesets bump the
    fixed group and the commit is still `main`'s head (`git ls-remote`).
    `changeset version --snapshot canary` writes `x.y.z-canary.<UTC datetime>` into the job's
    checkout (`x.y.z` is the planned version; nothing is committed), and the script checks that both packages carry that one
    canary version. A run for a commit that is no longer the head skips with a log line, so a
    delayed run or a rerun cannot move `canary` back to older code; a failed lookup fails the job. A
    changeset of only `none` entries bumps nothing.
  - **none**: every other commit, such as a docs change after a stable release.
- **Version Packages** (`version-packages.yml`) opens or updates the `changeset-release/main` PR with
  the next stable version, the changelogs and the lockfile. Only the run for `main`'s current head
  updates it. When no changeset bumps a version any more (the last pending change was reverted), it
  closes that PR with a comment instead, because the action itself leaves it open. Review the PR and
  squash merge it to release. When `main` moves, wait for this job to regenerate the PR rather than
  using "Update branch": merging `main` into it brings in changesets the PR's version did not count,
  and the stable job then refuses it.

**Approve the Version Packages PR's checks.** The PR is created and updated with `GITHUB_TOKEN`, so
GitHub creates its `pull_request` runs (**Merge** and **PR title**) in an approval-required state. A
maintainer with write access selects "Approve workflows to run" on the PR after each update. A
`workflow_dispatch` run would not help: its checks do not appear on the PR and do not satisfy
required checks
([GitHub docs](https://docs.github.com/en/actions/concepts/security/github_token)).

Both channels upload both packages under the staging dist-tag `pending` first (`@elmeragroup/intl`
before `@elmeragroup/intl-tools`, which pins its exact version), then move `canary` or `latest` to
both with `npm dist-tag add`. A channel tag therefore never points at half a pair. `latest` only
moves forward: a stable run whose version is not newer than npm's current `latest` leaves it, and a
stable always displaces a prerelease. `canary` relies on the head check instead, because a canary's
order is its datetime: after a changeset is reverted, the next canary can plan a lower version and
still be the newest code. npm gives `latest` to a package's first upload whatever its `--tag`
([npm/cli#8490](https://github.com/npm/cli/issues/8490)), so a canary job fails with
`canary-took-latest` if its canary took `latest`; see [Repository setup](#repository-setup). `pnpm publish` and
`npm dist-tag` authenticate through npm trusted publishing (the job's OIDC token, no stored npm
token), and `PNPM_CONFIG_PROVENANCE=true` makes every upload carry provenance or fail.

**Recovery.**

- **A stable run failed.** Rerun it from its Actions page. A rerun keeps the commit, so it picks
  `stable` again. `changeset publish` skips a version npm already has, and the promotion and the
  GitHub release are repeatable, so the rerun finishes what is missing. Rerunning an older stable run
  cannot move `latest` back.
- **A canary run failed.** A rerun publishes only while its commit is still `main`'s head, and then
  under a new datetime. Once `main` has moved, a canary rerun skips, so it cannot repair anything; the
  next merge with a pending bump publishes the next canary. A canary version left under `pending` by a
  failed run stays on npm, unused and untagged by any channel.
- **The two packages' channel tags are split**, because a promotion failed after moving one of them.
  `npm dist-tag add` overwrites whatever CI wrote meanwhile, so make the repair exclusive with CI:
  1. `gh workflow disable merge.yml --repo elmeragroup/intl`. Disabling stops new runs but does not
     cancel runs already queued or in progress
     ([disable and enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)).
  2. Wait until `gh run list --repo elmeragroup/intl --all --workflow merge.yml --branch main`
     shows no queued or in-progress run (`--all` includes the disabled workflow).
  3. From a session logged in to npm and to `gh`, with publish rights on both packages, run
     `node scripts/release.ts promote <version> <canary|latest>`. It refuses while a Merge run on
     `main` has not completed, checks that both packages have `<version>` on npm, reads both tags
     and decides for the pair before writing either. A tag moves only forward (`canary` by snapshot
     datetime, `latest` by semver), and a tag already at `<version>` stays. If the tags differ and
     one is ahead of `<version>`, it refuses and names the version that aligns both, when both
     packages have it. npm may prompt for a one-time password.
  4. `gh workflow enable merge.yml --repo elmeragroup/intl`. Never merge, or bypass branch
     protection, while it is disabled: the required checks cannot report, so PRs cannot merge
     ([step 3](#repository-setup)). A push that landed anyway gets no run, and dispatching
     `merge.yml` does not replace it, because the release jobs run only on `push`. A canary is then
     skipped until the next merge; a Version Packages commit would never get its stable run.
- **The GitHub release cannot be created.** If the release step fails and `main` then changes a
  workflow file, every rerun fails. GitHub requires workflow-write authorization to create a
  release whose target commit adds or modifies files under `.github/workflows/` relative to the
  default branch
  ([Create a release](https://docs.github.com/en/rest/releases/releases#create-a-release)), and the
  job's `GITHUB_TOKEN` has no `workflows` permission
  ([`permissions`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
  When `gh release create` fails, the job prints the exact commands with the same tag, commit and
  notes. A maintainer with write access to workflows runs them:
  `gh api repos/elmeragroup/intl/git/refs -f ref=refs/tags/v<version> -f sha=<built commit> && gh release create v<version> --verify-tag --title v<version> --notes <notes> --repo elmeragroup/intl`.
  GitHub attaches a release to an existing tag and ignores `--target`, so the tag is created first,
  which fails if it exists, and `--verify-tag` attaches the release only to that tag. After every
  create, and for a release that already exists, the job checks that the tag marks the built
  commit, and fails otherwise.
- **A draft release, or a tag at another commit.** If a draft release `v<version>` exists, or the tag
  `v<version>` points at a commit other than the built one, the stable job fails rather than reporting
  success. Check which commit the tag should mark, publish or delete the draft, delete or move the
  wrong tag, then rerun.

<a id="repository-setup"></a>

### Repository setup

Done once by an owner. No npm token is stored anywhere.

1. Create the GitHub environment `npm`, with a deployment branch rule that allows only `main`.
2. Allow GitHub Actions to create pull requests (Settings, Actions, General) for the Version Packages
   PR.
3. In `main`'s branch protection (or ruleset), require status checks to pass (`checks`, `e2e` and
   the PR title check) and check **Require branches to be up to date before merging**. Then "the
   branch must be up to date with the base branch before merging", and without required status
   checks "collaborators can merge the branch at any time, regardless of whether it is up to date"
   ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
   A Version Packages PR made stale by a new commit on `main` cannot merge until the Version Packages
   job regenerates it from `main` (the pinned `changesets/action` resets `changeset-release/main` to
   the pushed commit and reruns `pnpm release:version`). The stable job's refusal stays as the backstop.
4. **Create both package names from a maintainer session.** npm can add a trusted publisher only to
   a package that exists ([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust): "Package
   must exist"), and staged publishing can create a new package from a local session
   ([changelog](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)).
   Logged in to npm (npm 11.15.0 or later), run `pnpm build`, then in `packages/intl` and in
   `packages/intl-tools` run `pnpm pack` and `npm stage publish <tarball>` (`npm stage publish
   [<package-spec>]` "has parity with `npm publish`", which takes a tarball; the manifest's
   `publishConfig.access` makes it public). npm creates the name with a public placeholder version
   `0.0.0-stage`; the staged `0.0.0` stays private until a maintainer approves it
   ([staged publishing](https://docs.npmjs.com/staged-publishing)). Leave it staged for now: npm's
   docs say a reject "removes the selected staged versions without publishing them" but not whether
   the placeholder, and with it the package, survives.

   Then run `npm view @elmeragroup/intl dist-tags` and the same for `@elmeragroup/intl-tools`. npm
   gives `latest` to a package's first upload whatever its `--tag`, and `latest` cannot be deleted
   ([npm/cli#8490](https://github.com/npm/cli/issues/8490);
   [`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag): "Publishing a package sets
   the latest tag to the published version unless the --tag option is used"). npm's docs do not say
   whether the placeholder takes it. If both print `latest: 0.0.0-stage`, the names are seeded and
   the first canary cannot take `latest`. If not, the first canary takes `latest` on its package's
   first upload. The canary job then fails once with `canary-took-latest` after publishing and tagging
   both packages; plain installs get that canary until the first stable release, which always
   displaces a prerelease `latest`. No action is needed beyond releasing the first stable.

5. On npmjs.com, add a trusted publisher to `@elmeragroup/intl` and to `@elmeragroup/intl-tools`:
   repository `elmeragroup/intl`, workflow `merge.yml`, environment `npm`, with **Allow npm publish**
   and **Allow npm dist-tag** checked (dist-tag is off by default;
   [trusted publishers](https://docs.npmjs.com/trusted-publishers)). For a `workflow_call`, npm
   validates the calling workflow's filename, so the entry names `merge.yml`, not
   `publish-release.yml`. An entry that has not completed a publish within 2 days of its creation
   expires; delete it and create a new one, so add each entry shortly before the merge that publishes.
6. Set each package's publishing access to "Require two-factor authentication and disallow bypass
   2fa tokens", which stops every npm token from publishing and leaves trusted publishing working.
7. Merge the first changeset. Its canary is the first OIDC publish.
8. Reject both staged `0.0.0` versions (`npm stage reject <stage-id>`, with 2FA; `npm stage list`
   shows the ids). The packages now hold real versions, so the reject cannot remove them.

If npm refuses to create a name through staging, the fallback is a short-lived granular access token:
store it as an `npm` **environment** secret (not a repository secret), give it "Bypass two-factor
authentication" so CI can publish with it, pass it to the publish step as `NODE_AUTH_TOKEN` for the
first run only, then revoke the token on npmjs.com (deleting the GitHub secret does not revoke it)
and continue from step 5 (skip step 8). On this path the first canary is each package's first upload,
so it takes `latest` and the job fails with `canary-took-latest`, as described in step 4.

Build and publish share a job, so dependency code run by the build can request the job's OIDC token.
Closing that gap needs a publish job that only publishes archives built in another job.

## Merging and closing

Before merging, a code owner checks the problem, where the change lives, the scope and every
Verification row.

A code owner may close a PR or request changes when it belongs in a consuming app, solves several
independent problems, lacks a completed review or lacks evidence. The closing comment names the rule
and explains what would change the outcome.

Address the reason and reopen the PR, or open focused replacement PRs and link them to the original.
