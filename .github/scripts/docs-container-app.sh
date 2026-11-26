#!/usr/bin/env bash
set -euo pipefail

# The docs site's preview deployments on Azure Container Apps (.github/workflows/preview.yml), called after
# azure/login in the preview subscription. Infra owns the environment, the registry, the identity and RBAC; this
# script owns the preview app and its revisions, including the app's first deployment. Production is not set up.
#
#   origin-preview  print the origin the PR's preview serves, before its image is built
#   probe           print `placeholder=true` when the app has no bootstrap revision to reactivate, so the build must push
#                   the placeholder image, and `placeholder=false` otherwise
#   deploy          deploy the image as the PR's revision, labelled pr-<n>; report `outcome` (deployed or skipped), and
#                   the URL and revision as soon as the label is written
#   teardown        remove the PR's label; report `outcome` (removed, nothing or skipped)
#   reconcile       bring the app back to its rest state after either (see reconcile below)
#
# deploy and teardown change the one app every PR shares, and each label or traffic change rewrites the app's whole
# traffic list (azure-cli's containerapp module reads the app, edits the list and writes it back, with no ETag), so two
# at once could erase each other's label. The workflow runs them one at a time across all PRs.
#
# Every Azure read whose failure matters is a plain assignment at the top level or in a function called on its own,
# never inside a condition, so a failed read (an expired login, a missing permission) fails the run instead of reading
# as "absent". The few reads made inside a condition check their status themselves.
mode="${1:?Usage: docs-container-app.sh origin-preview|probe|deploy|teardown|reconcile}"
: "${APP:?Set APP}"
: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${PR:?Set PR}"
case "$mode" in
  origin-preview|probe|deploy|teardown|reconcile) ;;
  *) echo "Unknown deployment mode: $mode" >&2; exit 1 ;;
esac
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bootstrap="${APP}--bootstrap"
# azure-cli's `core.only_show_errors` setting, read from the environment (knack's AZURE_<section>_<option>), in place of
# `--only-show-errors` on every call.
export AZURE_CORE_ONLY_SHOW_ERRORS=true

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
  domain=$(az containerapp env show --ids "$ENVIRONMENT" --query properties.defaultDomain --output tsv)
  if [[ -z "$domain" ]]; then
    echo "Container Apps environment $ENVIRONMENT reported no default domain." >&2
    exit 1
  fi
  echo "https://${APP}---pr-${PR}.${domain}"
  exit 0
fi

# The live gate (docs-preview-gate.sh) for PR #<pr>, from inside this serialized section: the PR can change while the
# run waits in the queue or deploys. Returns 0 when the run may act, 3 when the PR has moved on, and 1 when the gate
# itself failed.
live_gate() {
  local out
  out=$(mktemp)
  if PR="$2" GITHUB_OUTPUT="$out" bash "$script_dir/docs-preview-gate.sh" "$1" >&2; then
    case "$(sed -n 's/^act=//p' "$out")" in
      true) return 0 ;;
      false) return 3 ;;
    esac
  fi
  echo "The live gate failed." >&2
  return 1
}

# Container Apps rejects a change while another operation is provisioning the app (409 ContainerAppOperationInProgress)
# or holds its lock (409 ContainerAppLockConflict), such as the platform's own work after a deploy. Each change waits
# out that rejection, bounded to about four minutes. A rejected change applied nothing, and each `az` change re-reads
# the app before writing it, so repeating it is safe. Any other error fails at once.
#
# `change_app --gate <mode> <pr> ...` runs the live gate for PR #<pr> before every attempt, so a wait of
# minutes never applies a decision the PR has since overturned (a `no-preview` label added, a PR reopened). Returns 0
# when the change applied, 3 only when the gate says the PR moved on, and 1 for every failure, the gate's or Azure's:
# az exits 3 too (ResourceNotFoundError), which must never read as a skip. `change_app --guard <function> <arg> ...` runs
# that check in the gate's place and returns its status when it is not 0.
change_app() {
  local gate=() attempt error status
  if [[ "$1" == --gate ]]; then
    gate=(live_gate "$2" "$3")
    shift 3
  elif [[ "$1" == --guard ]]; then
    gate=("$2" "$3")
    shift 3
  fi
  for attempt in {1..24}; do
    if [[ "${#gate[@]}" -gt 0 ]]; then
      "${gate[@]}" || return
    fi
    if error=$(az "$@" 2>&1); then
      return 0
    else
      status=$?
    fi
    echo "$error" >&2
    if [[ "$error" != *ContainerAppOperationInProgress* && "$error" != *ContainerAppLockConflict* ]]; then
      echo "az $1 $2 failed with status $status." >&2
      return 1
    fi
    if [[ "$attempt" -eq 24 ]]; then
      echo "Gave up after another operation kept the app busy (az status $status)." >&2
      return 1
    fi
    # Jitter keeps runs that waited on the same operation from colliding again.
    sleep $((5 + RANDOM % 11))
  done
}

# Whether the app exists. A successful list with no match means absent.
app=$(az containerapp list --resource-group "$RESOURCE_GROUP" --query "[?name == '${APP}'].name" --output tsv)
echo "App: ${app:-absent}." >&2

# Whether the app's bootstrap revision is active: `absent`, `inactive` or `active`. `revision list` returns only active
# revisions unless given `--all` (azure-cli's containerapp list_revisions), so the lookup passes it to tell a deactivated
# revision, which the deploy reactivates, from a missing one, which it recreates from the placeholder image. Only the
# probe and the deploy read it; teardown and reconcile need only the app's ingress.
read_bootstrap_state() {
  local active
  bootstrap_state=absent
  [[ -n "$app" ]] || return 0
  active=$(az containerapp revision list --all --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?name == '${bootstrap}'].to_string(properties.active)" --output tsv)
  case "$active" in
    true) bootstrap_state=active ;;
    false) bootstrap_state=inactive ;;
  esac
  echo "Bootstrap revision: $bootstrap_state." >&2
}

if [[ "$mode" == probe ]]; then
  read_bootstrap_state
  if [[ "$bootstrap_state" == absent ]]; then echo "placeholder=true"; else echo "placeholder=false"; fi
  exit 0
fi

: "${GITHUB_OUTPUT:?Set GITHUB_OUTPUT}"
: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY}"

# The app's default route is the `bootstrap` revision, which runs the placeholder image (apps/docs/placeholder) and
# answers 404, so no PR's code is ever served at the app's base hostname; each PR's revision is reached by its label.
# This makes it so, however an earlier run stopped: it creates the app, or the missing revision, from the placeholder,
# reactivates it, and pins the app's default traffic to it unless it already holds all of it. The app runs as the
# preview identity and pulls its images with it.
ensure_bootstrap() {
  local weight
  read_bootstrap_state
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
          --output none
      else
        echo "$APP has no bootstrap revision; creating it from the placeholder."
        change_app containerapp update --name "$APP" --resource-group "$RESOURCE_GROUP" \
          --image "$BOOTSTRAP_IMAGE" --revision-suffix bootstrap --output none
      fi ;;
    inactive)
      echo "Reactivating $bootstrap."
      change_app containerapp revision activate --name "$APP" --resource-group "$RESOURCE_GROUP" \
        --revision "$bootstrap" --output none ;;
    active) ;;
  esac
  weight=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?revisionName == '${bootstrap}'].weight | [0]" --output tsv)
  if [[ "$weight" != 100 ]]; then
    echo "Pinning $APP's default traffic to $bootstrap (it held '${weight}')."
    change_app containerapp ingress traffic set --name "$APP" --resource-group "$RESOURCE_GROUP" \
      --revision-weight "${bootstrap}=100" --output none
  fi
}

# The preview identity exists to pull images, so no container may request tokens for it: its lifecycle is `None`, which
# still lets the platform pull with it ("Use this when you have a managed identity that is only used for ACR image pull,
# scale rules, or Key Vault secrets", learn.microsoft.com/azure/container-apps/managed-identity, "Control managed
# identity availability"). Azure's default, `All`, would hand its tokens to every PR's code over IMDS. This sets it on a
# new app and on one created before it, before any PR revision exists, and changes nothing when it already holds.
#
# azure-cli 2.84's containerapp module has no flag for `identitySettings` (`create` and `update` build their bodies from
# their own arguments), so this is a generic `az resource patch` at the module's own API version (_clients.py
# CURRENT_API_VERSION), which waits for the operation as `az` does for every long-running one. A PATCH merges
# `configuration` and replaces the array, so the array is rebuilt from the current entries. The module's own changes
# send only what they edit (`update` PATCHes the template, the label commands only `ingress.traffic`), so they keep it.
ensure_identity_lifecycle() {
  local api_version=2025-07-01 app_json current settings
  app_json=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --output json |
    jq -c '{id, settings: (.properties.configuration.identitySettings // [])}')
  current=$(jq -r --arg id "$MANAGED_IDENTITY_ID" \
    '[.settings[] | select((.identity | ascii_downcase) == ($id | ascii_downcase)) | .lifecycle] | .[0] // "All (default)"' \
    <<< "$app_json")
  if [[ "$current" == None ]]; then
    echo "The preview identity's lifecycle is None."
    return 0
  fi
  echo "The preview identity's lifecycle is $current; setting it to None."
  settings=$(jq -c --arg id "$MANAGED_IDENTITY_ID" \
    '{configuration: {identitySettings: ([.settings[] | select((.identity | ascii_downcase) != ($id | ascii_downcase))]
      + [{identity: $id, lifecycle: "None"}])}}' <<< "$app_json")
  change_app resource patch --ids "$(jq -r .id <<< "$app_json")" --api-version "$api_version" \
    --properties "$settings" --output none
  current=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --output json |
    jq -r --arg id "$MANAGED_IDENTITY_ID" \
      '[(.properties.configuration.identitySettings // [])[] | select((.identity | ascii_downcase) == ($id | ascii_downcase)) | .lifecycle] | .[0] // "All (default)"')
  echo "The preview identity's lifecycle is now $current."
  if [[ "$current" != None ]]; then
    echo "The preview identity's lifecycle did not change to None; no PR revision is deployed." >&2
    exit 1
  fi
}

# Prints the app's routes and active revisions, which every label and reconcile decision reads, so the log shows the
# state each decision started from and the state the run left.
show_routes() {
  local traffic active
  traffic=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic" --output json | jq -c .)
  active=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[].name" --output json | jq -c .)
  echo "$1: traffic $traffic"
  echo "$1: active revisions $active"
}

# What Azure reports of a revision: its whole `properties` but its template, so a state, a replica count or a
# provisioning error no decision reads still shows.
describe_revision() {
  az containerapp revision show --name "$APP" --resource-group "$RESOURCE_GROUP" --revision "$1" --output json |
    jq -c '{name} + (.properties | del(.template))'
}

# Whether <name> is a line of <lines>, matched in bash itself: an external matcher's own failure (grep exits 2 on a read
# error) would read as "not there".
listed() {
  [[ $'\n'"$2"$'\n' == *$'\n'"$1"$'\n'* ]]
}

# The guard before every attempt to deactivate <revision>: 0 while no label points at it, 3 once one does (a label write
# from earlier in the run can apply after the CLI reported it failed), and 2 when the labels cannot be read.
unlabelled() {
  local labelled
  labelled=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label].revisionName" --output tsv) || return 2
  ! listed "$1" "$labelled" || return 3
}

# Deactivates a revision while no label points at it, checked before each attempt, including each retry after a 409.
# Returns change_app's status: 0 deactivated, 3 a label points at it now, 2 the labels could not be read, 1 failed.
deactivate() {
  echo "Deactivating $1."
  change_app --guard unlabelled "$1" containerapp revision deactivate --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --revision "$1" --output none
}

# Removes the label `pr-<n>` while GitHub reports PR #<n> closed: the teardown gate runs for that PR before every
# attempt, including each retry after a 409, so a PR that reopens meanwhile keeps its label. Returns change_app's
# status: 0 removed, 3 the PR is open again, 1 failed.
remove_label() {
  local status=0
  change_app --gate teardown "$1" containerapp revision label remove \
    --name "$APP" --resource-group "$RESOURCE_GROUP" --label "pr-$1" --output none || status=$?
  case "$status" in
    0) echo "Removed the label pr-$1: PR #$1 is closed." ;;
    3) echo "Kept the label pr-$1: PR #$1 is not closed." ;;
  esac
  return "$status"
}

# After the triggering PR's own change, under the lock, one rule brings the app back to its rest state:
#
#   1. a label `pr-<m>` stays unless GitHub reports PR #m closed, checked before each attempt to remove it. This covers
#      a PR that closed without its teardown, which GitHub skips for a PR with merge conflicts, the triggering PR
#      included if it closed while its deploy wrote the label; an open PR, such as the one just deployed, is a skip;
#   2. an active revision stays only if it is `bootstrap` or a label points at it (an older revision of a PR, or a
#      candidate a failed or stopped deploy left behind, is deactivated). Labels are read after step 1, from Azure, and
#      again before each attempt to deactivate, so a label write that applied although the CLI reported a failure, even
#      one that lands during the sweep, keeps its revision.
#
# It runs as its own step after the deploy or teardown, under the same lock, so its failure shows on its own and never
# hides an outcome already reported.
#
# Changes for the triggering PR must succeed; changes for any other PR are best effort, logged per PR, and never fail
# the run, so one PR's stale state cannot block another's preview. A failure for the triggering PR still lets the rest
# of the sweep run, then fails the step. A failed read of the app's labels or revisions ends the sweep at once, failing
# the step: read as empty, it would deactivate every live preview.
reconcile() {
  local labels label number status labelled revisions revision failed=false
  labels=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label].label" --output tsv) || return 1
  for label in $labels; do
    [[ "$label" =~ ^pr-([0-9]+)$ ]] || continue
    number="${BASH_REMATCH[1]}"
    status=0
    remove_label "$number" || status=$?
    if [[ "$status" != 0 && "$status" != 3 ]]; then
      echo "Reconcile PR #$number: could not remove its label." >&2
      [[ "$number" == "$PR" ]] && failed=true
    fi
  done
  labelled=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label].revisionName" --output tsv) || return 1
  revisions=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?properties.active].name" --output tsv) || return 1
  for revision in $revisions; do
    if [[ "$revision" == "$bootstrap" ]] || listed "$revision" "$labelled"; then
      continue
    fi
    status=0
    deactivate "$revision" || status=$?
    case "$status" in
      0) ;;
      3) echo "Kept $revision: a label points at it now." ;;
      2) echo "Reconcile: could not read the app's labels before deactivating $revision." >&2; return 1 ;;
      *)
        echo "Reconcile: could not deactivate $revision." >&2
        [[ "$revision" == "${APP}--pr-${PR}-"* ]] && failed=true ;;
    esac
  done
  show_routes "After the run"
  [[ "$failed" == false ]]
}

# Readiness is Azure's own signal: the app's latestReadyRevisionName reaching the candidate, polled every 10 seconds for
# up to five minutes. Only a terminal failure ends the wait early: the candidate's provisioning failed, or the app's
# provisioning failed with the candidate as its latest revision. Health, running and replica states pass through
# Unhealthy, Activating or zero replicas on the way, so they are printed on every poll, never decided on.
wait_until_ready() {
  local attempt revision_json app_json
  for attempt in {1..30}; do
    revision_json=$(describe_revision "$candidate")
    app_json=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --output json |
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

if [[ "$mode" == reconcile ]]; then
  if [[ -z "$app" ]]; then
    echo "No preview app exists; nothing to reconcile."
    exit 0
  fi
  # An open PR is the usual case, not news for the run's summary, so the gate's skips stay out of it.
  GITHUB_STEP_SUMMARY=/dev/null reconcile
  exit 0
fi

if [[ "$mode" == teardown ]]; then
  status=0
  live_gate teardown "$PR" || status=$?
  case "$status" in
    0) ;;
    3) echo "outcome=skipped" >> "$GITHUB_OUTPUT"; exit 0 ;;
    *) exit 1 ;;
  esac
  if [[ -z "$app" ]]; then
    echo "No preview app exists; nothing to remove."
    echo "outcome=nothing" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  label=$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.configuration.ingress.traffic[?label == 'pr-${PR}'].label | [0]" --output tsv)
  own=$(az containerapp revision list --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?properties.active && starts_with(name, '${APP}--pr-${PR}-')].name" --output tsv)
  outcome=nothing
  if [[ -n "$label" ]]; then
    status=0
    remove_label "$PR" || status=$?
    case "$status" in
      0) outcome=removed ;;
      3) outcome=skipped ;;
      *) exit 1 ;;
    esac
  elif [[ -n "$own" ]]; then
    # No label, but revisions of the PR's: the reconcile step deactivates them.
    outcome=removed
  fi
  echo "PR #$PR's preview: $outcome."
  echo "outcome=$outcome" >> "$GITHUB_OUTPUT"
  exit 0
fi

# The preview's URL is the origin the build baked into the image (origin-preview), checked here, before anything
# changes, so nothing stands between the label write and the outcome that announces it.
: "${IMAGE:?Set IMAGE}"
: "${ORIGIN:?Set ORIGIN}"
: "${MANAGED_IDENTITY_ID:?Set MANAGED_IDENTITY_ID}"
: "${SUFFIX:?Set SUFFIX}"
require_digest IMAGE "$IMAGE"
require_environment_id
if [[ ! "$ORIGIN" =~ ^"https://${APP}---pr-${PR}."[a-z0-9.-]+$ ]]; then
  echo "ORIGIN must be https://${APP}---pr-${PR}.<environment domain>, got: '$ORIGIN'" >&2
  exit 1
fi
ensure_bootstrap
ensure_identity_lifecycle
show_routes "Before the deploy"

# The reconcile step that follows owns the cleanup of a candidate that fails at any point below, because a label write
# can apply before Azure CLI reports an error, so only the labels Azure reports decide.
candidate="${APP}--${SUFFIX}"
echo "Deploying $IMAGE as $candidate."
if ! change_app containerapp update --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --image "$IMAGE" --revision-suffix "$SUFFIX" --output none; then
  echo "The update failed. What Azure reports of $candidate, if it exists:" >&2
  describe_revision "$candidate" >&2 || echo "(no such revision, or it could not be read)" >&2
  exit 1
fi
ready=false
wait_until_ready
if [[ "$ready" != true ]]; then
  exit 1
fi

# The PR may have moved on while the revision came up or while the label write waits out a 409: the gate runs before
# every attempt, and a stale candidate never takes the label. The outcome is reported as soon as the label is written;
# the reconcile step that follows cannot take it back.
echo "Labelling $candidate pr-${PR}."
status=0
change_app --gate deploy "$PR" containerapp revision label add --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --revision "$candidate" --label "pr-${PR}" --yes --output none || status=$?
case "$status" in
  0) ;;
  3)
    echo "The PR moved on before $candidate could take its label; it takes none."
    echo "outcome=skipped" >> "$GITHUB_OUTPUT"
    exit 0 ;;
  *) exit 1 ;;
esac
{
  echo "outcome=deployed"
  echo "url=${ORIGIN}"
  echo "revision=${candidate}"
} >> "$GITHUB_OUTPUT"
echo "PR #$PR's preview: $candidate."
