#!/usr/bin/env bash
set -euo pipefail

# Decides whether a preview run may still act, from the PR as GitHub reports it now rather than the event the run
# carries: a rerun replays its original event, and a run can wait in the queue while the PR moves on. The workflow runs
# it before the build, so a stale run skips cheaply, and docs-container-app.sh runs it again inside the serialized
# section right before the PR's label moves or its preview is removed.
#
#   deploy    act only while the PR is open, its head is still HEAD_SHA (the commit the run builds), and it has no
#             `no-preview` label
#   teardown  act only while the PR is closed
#
# Writes `act` (true or false) to GITHUB_OUTPUT and says why it did not act in the step summary. A failed read fails.
mode="${1:?Usage: docs-preview-gate.sh deploy|teardown}"
: "${PR:?Set PR}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY}"
: "${GITHUB_OUTPUT:?Set GITHUB_OUTPUT}"
: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY}"
case "$mode" in
  deploy) : "${HEAD_SHA:?Set HEAD_SHA}" ;;
  teardown) ;;
  *) echo "Unknown gate mode: $mode" >&2; exit 1 ;;
esac

live=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" \
  --jq '[.state, .head.sha, ([.labels[].name] | any(. == "no-preview") | tostring)] | join(" ")')
read -r state head no_preview <<< "$live"
echo "PR #$PR now: state=$state head=$head no-preview=$no_preview"

reason=""
if [[ "$mode" == deploy ]]; then
  if [[ "$state" != open ]]; then
    reason="the PR is now $state"
  elif [[ "$head" != "$HEAD_SHA" ]]; then
    reason="the PR's head is now ${head:0:7}, not ${HEAD_SHA:0:7}, which this run builds"
  elif [[ "$no_preview" == true ]]; then
    reason="the PR now carries the no-preview label"
  fi
elif [[ "$state" != closed ]]; then
  reason="the PR is $state again"
fi

if [[ -n "$reason" ]]; then
  echo "act=false" >> "$GITHUB_OUTPUT"
  {
    echo "### Preview $mode skipped"
    echo "This run's $mode stopped because $reason."
  } >> "$GITHUB_STEP_SUMMARY"
  echo "Skipping the $mode: $reason."
else
  echo "act=true" >> "$GITHUB_OUTPUT"
fi
