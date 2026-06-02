#!/usr/bin/env bash
# Deploy a Coolify "Docker Image" resource to an immutable image tag and verify
# the rollout. Shared by .github/workflows/cd.yml (app) and cd-website.yml (site).
#
# Required env:
#   COOLIFY_API_URL          base URL, e.g. http://host:8000
#   COOLIFY_API_TOKEN        Bearer token (needs write + read)
#   COOLIFY_RESOURCE_UUID    the Coolify application (resource) uuid
#   IMAGE                    registry image name, e.g. ghcr.io/icemint/tasca
#   SHA_TAG                  immutable tag, e.g. sha-abc1234
#
# Coolify won't re-pull a mutable tag on webhook redeploy (coolify #5318), so we
# PATCH the resource's image tag to SHA_TAG, trigger a deploy, then poll the
# rollout. Endpoints (Coolify v4):
#   PATCH /api/v1/applications/{uuid}   (docker_registry_image_name/_tag)
#   GET   /api/v1/deploy?uuid={uuid}    -> { deployments: [{ deployment_uuid }] }
#   GET   /api/v1/deployments/{uuid}    -> { status }
#
# Fail policy: fail-CLOSED on an explicit failed/cancelled/error rollout;
# fail-OPEN (warn, don't fail the job) if the rollout status can't be confirmed
# — the deploy request itself succeeded, and a queued/200 response alone must not
# be reported as success. The first few polls dump the raw response + HTTP code
# so the real status shape is visible in the logs.
set -uo pipefail

: "${COOLIFY_API_URL:?}" "${COOLIFY_API_TOKEN:?}" "${COOLIFY_RESOURCE_UUID:?}" "${IMAGE:?}" "${SHA_TAG:?}"
base="${COOLIFY_API_URL%/}"
auth="Authorization: Bearer ${COOLIFY_API_TOKEN}"

# 1) Point the resource at the new immutable image tag.
if ! curl -fsS -X PATCH "${base}/api/v1/applications/${COOLIFY_RESOURCE_UUID}" \
      -H "$auth" -H "Content-Type: application/json" \
      -d "{\"docker_registry_image_name\":\"${IMAGE}\",\"docker_registry_image_tag\":\"${SHA_TAG}\"}" >/dev/null; then
  echo "::error::PATCH application image tag failed"; exit 1
fi

# 2) Trigger the deploy; capture the deployment uuid.
resp=$(curl -fsS "${base}/api/v1/deploy?uuid=${COOLIFY_RESOURCE_UUID}" -H "$auth" || true)
echo "deploy: $resp"
dep=$(printf '%s' "$resp" | jq -r '.deployments[0].deployment_uuid // empty' 2>/dev/null || true)
if [ -z "$dep" ]; then echo "::error::no deployment_uuid in deploy response"; exit 1; fi
echo "tracking deployment ${dep}"

# 3) Poll rollout to terminal status (~10 min cap).
final=""
for i in $(seq 1 60); do
  sleep 10
  out=$(curl -sS -w $'\n%{http_code}' "${base}/api/v1/deployments/${dep}" -H "$auth" 2>/dev/null || true)
  code=$(printf '%s' "$out" | tail -n1)
  json=$(printf '%s' "$out" | sed '$d')
  st=$(printf '%s' "$json" | jq -r '(.status // .[0].status // .deployments[0].status) // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  if [ "$i" -le 3 ]; then echo "diag[$i] http=${code} body=$(printf '%s' "$json" | head -c 280)"; fi
  echo "rollout[$i]: http=${code} status=${st:-<none>}"
  case "$st" in
    finished*|success*)      final="success"; break ;;
    *fail*|*error*|*cancel*) final="$st"; break ;;
  esac
done

case "$final" in
  success) echo "✓ rollout succeeded"; exit 0 ;;
  "")      echo "::warning::rollout status not confirmed for ${dep} (deploy accepted; verify externally). Not failing the job."; exit 0 ;;
  *)       echo "::error::rollout ended in '${final}'"; exit 1 ;;
esac
