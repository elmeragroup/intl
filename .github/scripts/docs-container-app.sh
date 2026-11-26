#!/usr/bin/env bash
set -euo pipefail

# The docs site's preview deployments on Azure Container Apps (.github/workflows/preview.yml), called after
# azure/login in the preview subscription. Infra owns the environment, the registry, the identity and RBAC; this
# script owns the preview app and its revisions, including the app's first deployment. Production is not set up.
#
#   origin-preview  print the origin the PR's preview serves, before its image is built
#   probe           print `bootstrap=present` or `bootstrap=missing`: whether the app has its active bootstrap revision
#   deploy          deploy the image as the PR's revision, labelled pr-<n>, and report its URL
#   teardown        remove the PR's preview, and report `outcome` (removed, nothing or skipped)
#
# deploy and teardown change the one app every PR shares, and each label or traffic change rewrites the app's whole
# traffic list (azure-cli's containerapp module reads the app, edits the list and writes it back, with no ETag), so two
# at once could erase each other's label. The workflow runs them one at a time across all PRs.
#
# Every Azure read whose failure matters is a plain assignment at the top level or in a function called on its own,
# never inside a condition, so a failed read (an expired login, a missing permission) fails the run instead of reading
# as "absent". The few reads made inside a condition check their status themselves.
mode="${1:?Usage: docs-container-app.sh origin-preview|probe|deploy|teardown}"
: "${APP:?Set APP}"
: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${PR:?Set PR}"
case "$mode" in
  origin-preview|probe|deploy|teardown) ;;
  *) echo "Unknown deployment mode: $mode" >&2; exit 1 ;;
esac
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bootstrap="${APP}--bootstrap"

# The environment lives in another resource group than the app, so it is named by its full resource ID: a bare name
# would be looked up in the app's resource group.
require_environment_id() {
  : "${ENVIRONMENT:?Set ENVIRONMENT}"
  if [[ "$ENVIRONMENT" != /subscriptions/* ]]; then
    echo "ENVIRONMENT must be the Container Apps environment's resource ID (/subscriptions/...), got: $ENVIRONMENT" >&2
    exit 1
  fi
}

# An image the environment can pull, by digest, so a revision runs exactly what was pushed.
require_digest() {
  : "${REGISTRY:?Set REGISTRY}"
  if [[ "$2" != "${REGISTRY}.azurecr.io/intl-docs@sha256:"* ]]; then
    echo "$1 must be ${REGISTRY}.azurecr.io/intl-docs@sha256:..., got: '$2'" >&2
    exit 1
  fi
}

# origin-preview reads the environment's default domain rather than the app's FQDN, because the first deploy builds the
# image before the app exists. A preview is its `pr-<n>` label URL, `<app>---pr-<n>.<domain>`.
if [[ "$mode" == origin-preview ]]; then
  require_environment_id
  domain=$(az containerapp env show --ids "$ENVIRONMENT" \
    --query properties.defaultDomain --output tsv --only-show-errors)
  if [[ -z "$domain" ]]; then
    echo "Container Apps environment $ENVIRONMENT reported no default domain." >&2
    exit 1
  fi
  echo "https://${APP}---pr-${PR}.${domain}"
  exit 0
fi

# Container Apps rejects a change while another operation is provisioning the app (409 ContainerAppOperationInProgress)
# or holds its lock (409 ContainerAppLockConflict), such as the platform's own work after a deploy. Each change waits
# out that rejection, bounded to about four minutes. A rejected change applied nothing, and each `az` change re-reads
# the app before writing it, so repeating it is safe. Any other error fails at once.
change_app() {
  local attempt error status
  for attempt in {1..24}; do
    if error=$(az "$@" 2>&1); then
      return 0
    else
      status=$?
    fi
    echo "$error" >&2
    if [[ "$error" != *ContainerAppOperationInProgress* && "$error" != *ContainerAppLockConflict* ]]; then
      return "$status"
    fi
    if [[ "$attempt" -eq 24 ]]; then
      echo "Gave up after another operation kept the app busy." >&2
      return "$status"
    fi
    # Jitter keeps runs that waited on the same operation from colliding again.
    sleep $((5 + RANDOM % 11))
  done
}

# Whether the app exists, and whether its bootstrap revision is active: `absent`, `inactive` or `active`. A successful
# list with no match means absent. `revision list` returns only active revisions unless given `--all` (azure-cli's
# containerapp list_revisions), so the bootstrap lookup passes it to tell a deactivated revision from a missing one.
app=$(az containerapp list --resource-group "$RESOURCE_GROUP" \
  --query "[?name == '${APP}'].name" --output tsv --only-show-errors)
bootstrap_state=absent
if [[ -n "$app" ]]; then
  bootstrap_active=$(az containerapp revision list --all --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?name == '${bootstrap}'].to_string(properties.active)" --output tsv --only-show-errors)
  case "$bootstrap_active" in
    true) bootstrap_state=active ;;
    false) bootstrap_state=inactive ;;
  esac
fi
echo "App: ${app:-absent}; bootstrap revision: $bootstrap_state." >&2

if [[ "$mode" == probe ]]; then
  if [[ "$bootstrap_state" == active ]]; then echo "bootstrap=present"; else echo "bootstrap=missing"; fi
  exit 0
fi

: "${GITHUB_OUTPUT:?Set GITHUB_OUTPUT}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY}"

# The live gate (docs-preview-gate.sh), run again inside this serialized section right before the PR's label moves or
# its preview is removed: the PR can change while the run waits in the queue or deploys. Prints `true` or `false`, and
# nothing when the gate itself failed, which the caller treats as fatal.
gate_act() {
  local out
  out=$(mktemp)
  GITHUB_OUTPUT="$out" bash "$script_dir/docs-preview-gate.sh" "$1" >&2 || return 0
  sed -n 's/^act=//p' "$out"
}

# The app's default route is the `bootstrap` revision, which runs the placeholder image (apps/docs/placeholder) and
# answers 404, so no PR's code is ever served at the app's base hostname; each PR's revision is reached by its label.
# This makes it so, however an earlier run stopped: it creates the app, or the missing revision, from the placeholder,
# reactivates it, and pins the app's default traffic to it unless it already holds all of it. The app runs as the
# preview identity and pulls its images with it.
ensure_bootstrap() {
  local weight
  case "$bootstrap_state" in
    absent)
      require_digest BOOTSTRAP_IMAGE "${BOOTSTRAP_IMAGE:-}"
      if [[ -z "$app" ]]; then
        echo "Creating $APP on the placeholder."
        az containerapp create \
          --name "$APP" --resource-group "$RESOURCE_GROUP" \
          --environment "$ENVIRONMENT" --image "$BOOTSTRAP_IMAGE" \
          --user-assigned "$MANAGED_IDENTITY_ID" \
          --registry-server "${REGISTRY}.azurecr.io" --registry-identity "$MANAGED_IDENTITY_ID" \
          --ingress external --target-port 3000 \
          --revisions-mode multiple --revision-suffix bootstrap \
          --min-replicas 0 --max-replicas 3 \
          --scale-rule-name http --scale-rule-type http --scale-rule-http-concurrency 50 \
          --output none --only-show-errors
      else
        echo "$APP has no bootstrap revision; creating it from the placeholder."
        change_app containerapp update --name "$APP" --resource-group "$RESOURCE_GROUP" \
          --image "$BOOTSTRAP_IMAGE" --revision-suffix bootstrap --output none --only-show-errors
      fi ;;
    inactive)
      echo "Reactivating $bootstrap."
      change_app containerapp revision activate --name "$APP" --resource-group "$RESOURCE_GROUP" \
        --revision "$bootstrap" --output none --only-show-errors ;;
    active) ;;
  esac
  weight=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?revisionName == '${bootstrap}'].weight | [0]" \
    --output tsv --only-show-errors)
  if [[ "$weight" != 100 ]]; then
    echo "Pinning $APP's default traffic to $bootstrap (it held '${weight}')."
    change_app containerapp ingress traffic set --name "$APP" --resource-group "$RESOURCE_GROUP" \
      --revision-weight "${bootstrap}=100" --output none --only-show-errors
  fi
}

# Prints the app's routes and active revisions, which every label and reconcile decision reads, so the log shows the
# state each decision started from and the state the run left.
show_routes() {
  local traffic active
  traffic=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic" --output json --only-show-errors | jq -c .)
  active=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[].name" --output json --only-show-errors | jq -c .)
  echo "$1: traffic $traffic"
  echo "$1: active revisions $active"
}

# Deactivates a revision. Returns non-zero on failure; the caller decides whether that is fatal.
deactivate() {
  echo "Deactivating $1."
  change_app containerapp revision deactivate --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --revision "$1" --output none --only-show-errors
}

# After the triggering PR's own change, under the lock, one rule brings the app back to its rest state:
#
#   1. a label `pr-<m>` stays unless GitHub reports PR #m closed now (a PR that closed without its teardown, which
#      GitHub skips for a PR with merge conflicts, loses its label here);
#   2. an active revision stays only if it is `bootstrap` or a label points at it (an older revision of a PR, or a
#      candidate a stopped run left behind, is deactivated).
#
# Changes for the triggering PR must succeed; changes for any other PR are best effort, logged per PR, and never fail
# the run, so one PR's stale state cannot block another's preview.
reconcile() {
  local labels label number state labelled revisions revision
  labels=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label].label" --output tsv --only-show-errors)
  for label in $labels; do
    [[ "$label" =~ ^pr-([0-9]+)$ ]] || continue
    number="${BASH_REMATCH[1]}"
    [[ "$number" == "$PR" ]] && continue
    if ! state=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${number}" --jq .state); then
      echo "Reconcile PR #$number: could not read its state; leaving its label." >&2
      continue
    fi
    if [[ "$state" != closed ]]; then
      continue
    fi
    echo "Reconcile PR #$number: closed; removing its label."
    change_app containerapp revision label remove --name "$APP" --resource-group "$RESOURCE_GROUP" \
      --label "$label" --output none --only-show-errors ||
      echo "Reconcile PR #$number: could not remove its label." >&2
  done
  labelled=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label].revisionName" --output tsv --only-show-errors)
  revisions=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?properties.active].name" --output tsv --only-show-errors)
  for revision in $revisions; do
    if [[ "$revision" == "$bootstrap" ]] || grep -qxF "$revision" <<< "$labelled"; then
      continue
    fi
    if [[ "$revision" == "${APP}--pr-${PR}-"* ]]; then
      deactivate "$revision"
    else
      deactivate "$revision" || echo "Reconcile: could not deactivate $revision; leaving it." >&2
    fi
  done
}

# Readiness is Azure's own signal: the app's latestReadyRevisionName reaching the candidate, polled every 10 seconds for
# up to five minutes. Only a terminal failure ends the wait early: the candidate's provisioning failed, or the app's
# provisioning failed with the candidate as its latest revision. Health, running and replica states pass through
# Unhealthy, Activating or zero replicas on the way, so they are printed on every poll, never decided on.
wait_until_ready() {
  local attempt revision_json app_json
  for attempt in {1..30}; do
    # The revision's whole `properties` but its template, so a state, a replica count or a provisioning error the
    # decision does not read still shows.
    revision_json=$(az containerapp revision show --name "$APP" --resource-group "$RESOURCE_GROUP" \
      --revision "$candidate" --output json --only-show-errors | jq -c '{name} + (.properties | del(.template))')
    app_json=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --output json --only-show-errors |
      jq -c '{provisioningState: .properties.provisioningState, latestRevisionName: .properties.latestRevisionName, latestReadyRevisionName: .properties.latestReadyRevisionName}')
    echo "Poll $attempt: revision $revision_json"
    echo "Poll $attempt: app      $app_json"
    if [[ "$(jq -r .latestReadyRevisionName <<< "$app_json")" == "$candidate" ]]; then
      ready=true
      return 0
    fi
    if [[ "$(jq -r .provisioningState <<< "$revision_json")" == Failed ]]; then
      echo "Revision $candidate failed to provision." >&2
      return 0
    fi
    if [[ "$(jq -r '.latestRevisionName + " " + .provisioningState' <<< "$app_json")" == "$candidate Failed" ]]; then
      echo "The app failed to provision revision $candidate." >&2
      return 0
    fi
    sleep 10
  done
  echo "Timed out after five minutes: $candidate never became the app's latest ready revision." >&2
}

if [[ "$mode" == teardown ]]; then
  act=$(gate_act teardown)
  case "$act" in
    true) ;;
    false) echo "outcome=skipped" >> "$GITHUB_OUTPUT"; exit 0 ;;
    *) echo "The live gate failed." >&2; exit 1 ;;
  esac
  if [[ -z "$app" ]]; then
    echo "No preview app exists; nothing to remove."
    echo "outcome=nothing" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  label=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label == 'pr-${PR}'].label | [0]" --output tsv --only-show-errors)
  own=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?properties.active && starts_with(name, '${APP}--pr-${PR}-')].name" --output tsv --only-show-errors)
  if [[ -n "$label" ]]; then
    echo "Removing the label pr-${PR}."
    change_app containerapp revision label remove --name "$APP" --resource-group "$RESOURCE_GROUP" \
      --label "pr-${PR}" --output none --only-show-errors
  fi
  reconcile
  show_routes "After the teardown"
  if [[ -n "$label" || -n "$own" ]]; then outcome=removed; else outcome=nothing; fi
  echo "PR #$PR's preview: $outcome."
  echo "outcome=$outcome" >> "$GITHUB_OUTPUT"
  exit 0
fi

: "${IMAGE:?Set IMAGE}"
: "${MANAGED_IDENTITY_ID:?Set MANAGED_IDENTITY_ID}"
: "${SUFFIX:?Set SUFFIX}"
require_digest IMAGE "$IMAGE"
require_environment_id
ensure_bootstrap
show_routes "Before the deploy"

candidate="${APP}--${SUFFIX}"
echo "Deploying $IMAGE as $candidate."
# A failed update can still leave the candidate behind; it carries no label, so the next run's reconcile deactivates it.
if ! change_app containerapp update --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --image "$IMAGE" --revision-suffix "$SUFFIX" --output none --only-show-errors; then
  echo "The update failed. What Azure reports of $candidate, if it exists:" >&2
  az containerapp revision show --name "$APP" --resource-group "$RESOURCE_GROUP" --revision "$candidate" \
    --output json --only-show-errors | jq -c '{name} + (.properties | del(.template))' >&2 ||
    echo "(no such revision, or it could not be read)" >&2
  exit 1
fi
ready=false
wait_until_ready
if [[ "$ready" != true ]]; then
  deactivate "$candidate"
  exit 1
fi

# The PR may have moved on while the revision came up: a stale candidate never takes the label.
act=$(gate_act deploy)
case "$act" in
  true) ;;
  false) echo "The PR moved on while $candidate came up; it takes no label."; deactivate "$candidate"; exit 0 ;;
  *) echo "The live gate failed; $candidate takes no label." >&2; deactivate "$candidate"; exit 1 ;;
esac
echo "Labelling $candidate pr-${PR}."
change_app containerapp revision label add --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --revision "$candidate" --label "pr-${PR}" --yes --output none --only-show-errors
reconcile
show_routes "After the deploy"
fqdn=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn --output tsv --only-show-errors)
echo "url=https://${APP}---pr-${PR}.${fqdn#*.}" >> "$GITHUB_OUTPUT"
echo "revision=${candidate}" >> "$GITHUB_OUTPUT"
