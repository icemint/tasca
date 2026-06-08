#!/usr/bin/env bash
# Prove the runner's egress boundary LOCALLY — the deploy/egress panel's break-target.
#
# It stands up ONLY the egress-proxy on an `--internal` (no-internet) network, plus a
# probe container on that same internal network (the runner's position), and asserts:
#
#   1. ALLOWED host (api.github.com) is reachable THROUGH the proxy.
#   2. DENIED  host (example.com)    is BLOCKED by the proxy (403, deny-by-default).
#   3. DIRECT egress (no proxy) FAILS — the internal network has no route to the internet,
#      so even an agent that unsets HTTPS_PROXY cannot reach ANY external host.
#
# Exit 0 iff all three hold. No app, no DB — just the network boundary.
set -uo pipefail

NET=tasca-egress-verify
PROXY=tasca-egress-proxy-verify
IMG=tasca-egress-proxy:verify
CURL=curlimages/curl:8.11.1
PROBE="docker run --rm --network $NET -e HTTPS_PROXY=http://$PROXY:8888 $CURL"
fail=0

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> building egress-proxy image"
docker build -q -t "$IMG" "$(dirname "$0")/egress-proxy" >/dev/null || { echo "build failed"; exit 1; }

echo "==> creating internal (no-internet) network + proxy (bridged to the internet)"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$PROXY" --network "$NET" "$IMG" >/dev/null
docker network connect bridge "$PROXY" >/dev/null # the proxy's ONLY internet NIC
sleep 2

pass() { echo "  PASS: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

echo "==> 1. ALLOWED host via proxy (expect reachable)"
# api.github.com answers 200 at its root — a real GitHub HTTP response (not a proxy 403)
# means the CONNECT was allowed and reached GitHub.
code=$($PROBE -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.github.com 2>/dev/null)
if [ "$code" = "200" ]; then
  pass "api.github.com reachable through the proxy (HTTP $code)"
else
  bad "api.github.com NOT reachable through the proxy (got '$code')"
fi

echo "==> 2. DENIED host via proxy (expect blocked)"
out=$($PROBE -sS -o /dev/null --max-time 20 https://example.com 2>&1)
rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; then
  pass "example.com blocked by the proxy (deny-by-default)"
else
  bad "example.com was NOT blocked (rc=$rc, out='$out')"
fi

echo "==> 3. DIRECT egress, NO proxy (expect no route — agent cannot bypass)"
out=$(docker run --rm --network "$NET" "$CURL" -sS -o /dev/null --max-time 8 https://api.github.com 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
  pass "direct egress impossible from the internal network (rc=$rc)"
else
  bad "DIRECT egress SUCCEEDED — the internal network is not isolating (token-exfil path open!)"
fi

echo "==> 4. LOOK-ALIKE host via proxy (expect blocked — the regex must anchor)"
# evilgithub.com ends with 'github.com' but is NOT a subdomain; the (^|\.) anchor must
# deny it, else a prompt-injected agent registers a look-alike and exfiltrates through it.
out=$($PROBE -sS -o /dev/null --max-time 20 https://evilgithub.com 2>&1)
rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qiE '403|forbidden|denied|CONNECT'; then
  pass "evilgithub.com blocked (allowlist anchors to apex/subdomain only)"
else
  bad "look-alike evilgithub.com was NOT blocked (rc=$rc, out='$out')"
fi

echo "==> 5. ALLOWED subdomain via proxy (expect reachable — real agent traffic works)"
code=$($PROBE -sS -o /dev/null -w '%{http_code}' --max-time 20 https://raw.githubusercontent.com 2>/dev/null)
# raw.githubusercontent.com returns 301/302/400-ish at root, but ANY real HTTP code (not
# 000) means the CONNECT was allowed and reached GitHub.
if [ -n "$code" ] && [ "$code" != "000" ]; then
  pass "raw.githubusercontent.com reachable through the proxy (HTTP $code)"
else
  bad "allowed subdomain raw.githubusercontent.com NOT reachable (got '$code')"
fi

echo
if [ $fail -eq 0 ]; then echo "EGRESS BOUNDARY HOLDS ✓"; else echo "EGRESS BOUNDARY BROKEN ✗"; fi
exit $fail
