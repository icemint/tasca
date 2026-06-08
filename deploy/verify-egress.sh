#!/usr/bin/env bash
# Prove the runner's egress boundary LOCALLY — the deploy/egress panel's break-target.
#
# Two parts:
#   PART A (static): lint deploy/compose.yml — every network the runner attaches to is
#     internal:true, and the runner is NOT on the internet-facing `frontend`. This catches a
#     future regression the runtime probe (a hand-built single network) cannot model.
#   PART B (runtime): stand up the egress-proxy on an `--internal` (no-internet) network plus
#     a probe in the runner's position, and assert:
#       1. ALLOWED host (api.github.com) reachable THROUGH the proxy.
#       2. DENIED  host (example.com)    BLOCKED by the proxy (deny-by-default).
#       3. NO ROUTE off the proxy — proven against a LITERAL PUBLIC IP so the failure is a
#          routing failure (rc 7/28), NOT a DNS failure (rc 6) that would pass for the wrong
#          reason. This is the load-bearing assertion of the thesis.
#       4. LOOK-ALIKE host (evilgithub.com) blocked (the regex must anchor).
#       5. ALLOWED subdomain (raw.githubusercontent.com) reachable.
#       6. RAW-IP CONNECT via the proxy blocked (the allowlist is host-based; an IP literal
#          matches no host pattern → deny-by-default).
#       7. NON-443 CONNECT via the proxy blocked (ConnectPort 443 — no arbitrary-port tunnels).
#
# NB: egress filtering stops exfil to ARBITRARY third parties. It is NOT a confidentiality
# boundary against a GitHub-capable attacker (GitHub is allowlisted + attacker-writable) — see
# docs/decisions/2026-06-09-coordination-execution-split.md. This script proves the former.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$HERE/compose.yml"
NET=tasca-egress-verify
PROXY=tasca-egress-proxy-verify
IMG=tasca-egress-proxy:verify
CURL=curlimages/curl:8.11.1
PROBE="docker run --rm --network $NET -e HTTPS_PROXY=http://$PROXY:8888 $CURL"
# A GitHub public IP literal — used to prove pure route-absence (no DNS in the path).
PUBLIC_IP=140.82.112.3
fail=0
pass() { echo "  PASS: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> A. STATIC: deploy/compose.yml runner egress isolation"
tmpcfg=$(mktemp)
docker compose -f "$COMPOSE" config --format json >"$tmpcfg" 2>/dev/null
python3 - "$tmpcfg" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
nets = cfg.get('networks', {})
runner_nets = list((cfg.get('services', {}).get('runner', {}).get('networks', {}) or {}).keys())
ok = True
if not runner_nets:
    print("  FAIL: runner has no networks"); ok = False
if 'frontend' in runner_nets:
    print("  FAIL: runner is on `frontend` (internet-facing) — must not be"); ok = False
for n in runner_nets:
    if not nets.get(n, {}).get('internal', False):
        print(f"  FAIL: runner network `{n}` is not internal:true"); ok = False
if ok:
    print(f"  PASS: runner attaches only to internal:true networks {runner_nets}")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || fail=1
rm -f "$tmpcfg"

echo "==> building egress-proxy image"
docker build -q -t "$IMG" "$HERE/egress-proxy" >/dev/null || { echo "build failed"; exit 1; }

echo "==> creating internal (no-internet) network + proxy (bridged to the internet)"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$PROXY" --network "$NET" "$IMG" >/dev/null
docker network connect bridge "$PROXY" >/dev/null # the proxy's ONLY internet NIC
sleep 2

echo "==> 1. ALLOWED host via proxy (expect reachable)"
code=$($PROBE -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.github.com 2>/dev/null)
[ "$code" = "200" ] && pass "api.github.com reachable through the proxy (HTTP $code)" \
  || bad "api.github.com NOT reachable through the proxy (got '$code')"

echo "==> 2. DENIED host via proxy (expect blocked)"
out=$($PROBE -sS -o /dev/null --max-time 20 https://example.com 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; } \
  && pass "example.com blocked by the proxy (deny-by-default)" \
  || bad "example.com was NOT blocked (rc=$rc, out='$out')"

echo "==> 3. NO ROUTE off the proxy — LITERAL IP (failure must be routing, not DNS)"
# Direct (no proxy) to a public IP literal: no DNS in the path, so a non-zero exit is a
# genuine route-absence (curl rc 7 connect-failed / 28 timeout), NOT rc 6 (DNS).
out=$(docker run --rm --network "$NET" "$CURL" -sS -o /dev/null --connect-timeout 6 "https://$PUBLIC_IP" 2>&1); rc=$?
if [ "$rc" = "7" ] || [ "$rc" = "28" ]; then
  pass "no route to a public IP from the internal network (curl rc=$rc = connect/timeout)"
elif [ "$rc" = "6" ]; then
  bad "got rc=6 (DNS) — the IP-literal path must not hit DNS; test is unsound"
else
  bad "unexpected direct-egress result (rc=$rc, out='$out')"
fi

echo "==> 4. LOOK-ALIKE host via proxy (expect blocked — the regex must anchor)"
out=$($PROBE -sS -o /dev/null --max-time 20 https://evilgithub.com 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; } \
  && pass "evilgithub.com blocked (allowlist anchors to apex/subdomain only)" \
  || bad "look-alike evilgithub.com was NOT blocked (rc=$rc, out='$out')"

echo "==> 5. ALLOWED subdomain via proxy (expect reachable — real agent traffic works)"
code=$($PROBE -sS -o /dev/null -w '%{http_code}' --max-time 20 https://raw.githubusercontent.com 2>/dev/null)
{ [ -n "$code" ] && [ "$code" != "000" ]; } \
  && pass "raw.githubusercontent.com reachable through the proxy (HTTP $code)" \
  || bad "allowed subdomain raw.githubusercontent.com NOT reachable (got '$code')"

echo "==> 6. RAW-IP CONNECT via proxy (expect blocked — host-based allowlist)"
out=$($PROBE -sS -o /dev/null --max-time 15 "https://$PUBLIC_IP" 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; } \
  && pass "CONNECT to a raw IP literal blocked (matches no host pattern)" \
  || bad "raw-IP CONNECT via proxy was NOT blocked (rc=$rc, out='$out')"

echo "==> 7. NON-443 CONNECT via proxy (expect blocked — ConnectPort 443 only)"
out=$($PROBE -sS -o /dev/null --max-time 15 https://github.com:8443 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; } \
  && pass "CONNECT to an allowed host on :8443 blocked (no arbitrary-port tunnels)" \
  || bad "non-443 CONNECT was NOT blocked (rc=$rc, out='$out')"

echo
if [ $fail -eq 0 ]; then echo "EGRESS TOPOLOGY HOLDS ✓ (no arbitrary-third-party route)"; else echo "EGRESS BOUNDARY BROKEN ✗"; fi
exit $fail
