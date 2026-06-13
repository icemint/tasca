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
# Optional env (live-SHA verification — opt-in; the app/site deploys don't set these):
#   VERIFY_SHA_URL           public endpoint returning the deployed build SHA, e.g. https://api.tasca.dev/version
#   EXPECT_SHA               the SHA that endpoint must report once live, e.g. abc1234
#
# Coolify won't re-pull a mutable tag on webhook redeploy (coolify #5318), so we
# PATCH the resource's image tag to SHA_TAG, trigger a deploy, then poll the
# rollout. Endpoints (Coolify v4):
#   PATCH /api/v1/applications/{uuid}   (docker_registry_image_name/_tag)
#   GET   /api/v1/applications/{uuid}   -> { docker_registry_image_tag }   (PATCH-stuck check)
#   GET   /api/v1/deploy?uuid={uuid}    -> { deployments: [{ deployment_uuid }] }
#   GET   /api/v1/deployments/{uuid}    -> { status }
#
# Fail policy:
#   - fail-CLOSED on an explicit failed/cancelled/error rollout.
#   - When VERIFY_SHA_URL+EXPECT_SHA are set, the LIVE-SHA check is AUTHORITATIVE: the job
#     passes only if the deployed container reports EXPECT_SHA, and fails otherwise — even
#     if Coolify's deployment record said "finished" (that record can report success while
#     #5318 silently re-served the OLD image). This is the whole point: "merged" must mean
#     "the new image is actually serving."
#   - Without those vars (app/site): legacy behaviour — fail-OPEN (warn, don't fail) when the
#     rollout status can't be confirmed; a queued/200 alone must not be reported as success.
# The first few polls dump the raw response + HTTP code so the real status shape is visible.
set -uo pipefail

: "${COOLIFY_API_URL:?}" "${COOLIFY_API_TOKEN:?}" "${COOLIFY_RESOURCE_UUID:?}" "${IMAGE:?}" "${SHA_TAG:?}"
base="${COOLIFY_API_URL%/}"
auth="Authorization: Bearer ${COOLIFY_API_TOKEN}"

# 1) Point the resource at the new immutable image tag. Keep the response (don't discard it).
patch=$(curl -fsS -X PATCH "${base}/api/v1/applications/${COOLIFY_RESOURCE_UUID}" \
      -H "$auth" -H "Content-Type: application/json" \
      -d "{\"docker_registry_image_name\":\"${IMAGE}\",\"docker_registry_image_tag\":\"${SHA_TAG}\"}" 2>/dev/null) || {
  echo "::error::PATCH application image tag failed"; exit 1
}

# 1b) Confirm the PATCH stuck. Diagnostic, not a hard gate (the live-SHA check below is the real
# proof) — but a mismatch here is the leading indicator of a redeploy about to roll the old image.
got_tag=$(curl -fsS "${base}/api/v1/applications/${COOLIFY_RESOURCE_UUID}" -H "$auth" 2>/dev/null \
  | jq -r '.docker_registry_image_tag // empty' 2>/dev/null || true)
if [ -n "$got_tag" ] && [ "$got_tag" != "$SHA_TAG" ]; then
  echo "::warning::resource image tag reads '${got_tag}', expected '${SHA_TAG}' — PATCH may not have applied"
else
  echo "resource image tag = ${got_tag:-<unread>} (expected ${SHA_TAG})"
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

# An explicit rollout failure fails the job regardless of any other check.
case "$final" in
  *fail*|*error*|*cancel*) echo "::error::rollout ended in '${final}'"; exit 1 ;;
esac

# Authoritative gate (opt-in): the LIVE container must report EXPECT_SHA. A "finished" Coolify
# record is NOT enough — #5318 can report finished while serving the old image. Poll the public
# /version until it matches (the new container may take a moment to come up), else FAIL.
if [ -n "${VERIFY_SHA_URL:-}" ] && [ -n "${EXPECT_SHA:-}" ]; then
  if [ "$final" = "success" ]; then
    echo "rollout reported finished — confirming the live image is build ${EXPECT_SHA}…"
  else
    echo "::warning::rollout status unconfirmed — relying on the live-SHA check to decide."
  fi
  live=""
  for i in $(seq 1 18); do  # ~3 min (18 × 10s) for the new container to take traffic
    live=$(curl -fsS --max-time 8 "${VERIFY_SHA_URL}" 2>/dev/null | tr -d '[:space:]' || true)
    echo "verify[$i]: ${VERIFY_SHA_URL} -> ${live:-<unreachable>} (want ${EXPECT_SHA})"
    if [ "$live" = "$EXPECT_SHA" ]; then echo "✓ live image is build ${EXPECT_SHA} — deploy verified"; exit 0; fi
    sleep 10
  done
  echo "::error::live build never became ${EXPECT_SHA} (Coolify likely re-served the OLD image — coolify #5318). Last seen: ${live:-<unreachable>}"
  exit 1
fi

# Legacy behaviour (app/site — no live-SHA endpoint to gate on).
case "$final" in
  success) echo "✓ rollout succeeded"; exit 0 ;;
  "")      echo "::warning::rollout status not confirmed for ${dep} (deploy accepted; verify externally). Not failing the job."; exit 0 ;;
esac
