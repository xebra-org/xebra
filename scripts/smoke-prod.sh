#!/usr/bin/env bash
#
# Is the deployed app working? Read-only: it only GETs, and sends nothing to any chain.
#
#   BASE_URL=https://xebra.exchange       ./scripts/smoke-prod.sh
#   BASE_URL=http://localhost:3111          ./scripts/smoke-prod.sh   # a local production build
#   BASE_URL=https://<preview> VERCEL_BYPASS_SECRET=<secret> ./scripts/smoke-prod.sh   # a protected preview
#
# It checks the things that broke or could break at cutover, against REAL data:
#   - the pages serve, and the built app points at wrapper v2 (and not at v1);
#   - Circle is reachable through the pre-flight route, for both destinations and the new-account price;
#   - the delivery route reads Circle's verdict for a transfer that really happened on mainnet
#     (the first v2 test, 2026-09-24) and reports it delivered, with the right Solana transaction;
#   - the attestation route serves that transfer's proof, and the recipient lookup finds its account;
#   - the routes that call Circle directly (Arc and the EVM chains, Arc -> Solana) are priced, the
#     chains left out on purpose are refused, and the status routes take an EVM burn by its chain;
#   - the attestation route reports the nonce and expiry a Fast transfer's claim needs;
#   - the removed relay routes are gone;
#   - what search engines and assistants read is served: robots.txt, the sitemap, llms.txt, a
#     page's Markdown copy, its link-preview image, and a canonical URL and JSON-LD on the page;
#   - the shared Iris rate counter (Convex) is the one in use, not the per-instance fallback.
#
# Exit status is the number of failed checks, so it can gate a deploy.

set -uo pipefail

BASE_URL="${BASE_URL:?set BASE_URL, e.g. https://xebra.exchange}"
BASE_URL="${BASE_URL%/}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V2="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapperV2']['contractId'])")"
V1="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapper']['contractId'])")"

# The first real transfer through v2: 3.7 USDC Stellar -> Solana, delivered by Circle.
TX="cca4af89bff152915eacf4fc1650db49d71e1dd57a9725d7a97e6421162cd7b3"
FORWARD_TX="2fpvybw9SE5A599N8w5JtERWduo8eDJJc7mZoPFXHJRgtP5HDJfXMJ68vYKzFQUZEAAchzv3bsPLsEv4BkNz3Wvs"
RECIPIENT="C98dmk3BdRwmTTVNdutnzYp9sJSjnhp22ionPRXPXbDR"

# Vercel preview deployments sit behind deployment protection; pass the automation bypass secret to test one.
H=()
[ -n "${VERCEL_BYPASS_SECRET:-}" ] && H=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS_SECRET")

FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
get()  { curl -s ${H[@]+"${H[@]}"} -m 40 -A "xebra-smoke/1" -w '\n%{http_code}' "$BASE_URL$1"; }
# check <label> <path> <expected status> [python assertion over the parsed body `b`]
check() {
  local label="$1" path="$2" want="$3" assertion="${4:-}" out code body
  out="$(get "$path")"; code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" != "$want" ]; then fail "$label: expected HTTP $want, got $code"; return; fi
  if [ -n "$assertion" ]; then
    if BODY="$body" python3 -c "
import json, os, sys
b = json.loads(os.environ['BODY'])
sys.exit(0 if ($assertion) else 1)" 2>/dev/null; then pass "$label"; else fail "$label: unexpected body: ${body:0:200}"; fi
  else
    pass "$label"
  fi
}

echo "smoke test: $BASE_URL"
echo "expecting wrapper v2 $V2 (not v1 $V1)"
echo

echo "pages"
for p in / /claim /recover; do
  code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL$p")"
  [ "$code" = "200" ] && pass "GET $p" || fail "GET $p returned $code"
done

echo "built app points at wrapper v2"
HTML="$(curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL/")"
CHUNKS="$(echo "$HTML" | grep -oE '/_next/static/chunks/[^"]+\.js' | sort -u)"
FOUND_V2=0; FOUND_V1=0
for c in $CHUNKS; do
  js="$(curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL$c")"
  echo "$js" | grep -q "$V2" && FOUND_V2=1
  # Only the bridge's own id counts. v1 may legitimately appear as the LEGACY id, which the admin
  # panel reads to show v1's rent and nothing else uses.
  echo "$js" | grep -q "NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID:\"$V1\"" && FOUND_V1=1
done
[ "$FOUND_V2" = 1 ] && pass "v2 contract id is in the client bundle" || fail "v2 contract id is NOT in the client bundle (NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID wrong at build time?)"
[ "$FOUND_V1" = 0 ] && pass "the bridge does not point at v1" || fail "the bridge still points at v1"

echo "Circle pre-flight (live Circle calls)"
check "solana, existing account"  "/api/circle-health?dest=solana"               200 "b['status'] in ('ok','degraded') and 0 < b['quote']['high'] < 2000000 and b['quote']['high'] >= b['quote']['low']"
check "solana, new account price" "/api/circle-health?dest=solana&newAccount=1"   200 "b['status'] in ('ok','degraded') and b['quote']['high'] > 200000"
check "arc"                       "/api/circle-health?dest=arc"                   200 "b['status'] in ('ok','degraded') and 0 < b['quote']['high'] < 2000000"
check "rejects an unknown destination" "/api/circle-health?dest=btc"              400
echo "  (a status of 'down' above would mean Circle is unhealthy right now, not that the app is broken: re-run in a minute)"

echo "EVM routes (live Circle calls; served whether or not the build offers them)"
check "base -> arc, both speeds"       "/api/circle-health?src=6&dst=26"  200 "b['status'] in ('ok','degraded') and 0 < b['tiers']['standard']['high'] <= 100000 and b['tiers']['standard']['minimumFeePpb'] == 0 and b['tiers']['fast']['finalityThreshold'] == 1000"
check "arc -> hyperevm"                 "/api/circle-health?src=26&dst=19" 200 "b['status'] in ('ok','degraded') and 0 < b['quote']['high'] <= 500000"
check "arc -> solana, opening the account"  "/api/circle-health?src=26&dst=5&newAccount=1" 200 "b['status'] in ('ok','degraded') and 200000 < b['quote']['high'] <= 1000000"
check "ink -> arc"                       "/api/circle-health?src=21&dst=26" 200 "b['status'] in ('ok','degraded') and b['quote']['high'] > 0"
for left in 0 11 22 28; do
  check "chain $left is not offered (left out on purpose)" "/api/circle-health?src=26&dst=$left" 400
done
check "rejects a route between two peers" "/api/circle-health?src=6&dst=3" 400
check "rejects solana as a source"        "/api/circle-health?src=5&dst=26" 400

echo "delivery of a real transfer"
check "delivery reads Circle's verdict" "/api/delivery?tx=$TX" 200 "b['status']=='known' and b['state']=='delivered' and b['forwardTxHash']=='$FORWARD_TX'"
check "delivery rejects a bad hash"     "/api/delivery?tx=zz"  400
check "delivery asks Circle about an EVM burn"  "/api/delivery?tx=0x$TX&src=6" 200 "b['status'] in ('known','unknown')"
check "delivery wants a chain for an EVM hash"  "/api/delivery?tx=0x$TX"       400
check "delivery refuses a chain we do not burn on" "/api/delivery?tx=$TX&src=5" 400
check "attestation names the nonce and expiry"  "/api/attestation?tx=$TX" 200 "b['eventNonce'].startswith('0x') and b['expirationBlock'] == '0'"
check "attestation is served for it"    "/api/attestation?tx=$TX" 200 "b['status']=='complete' and b['destinationDomain']==5 and b['message'].startswith('0x') and b['attestation'].startswith('0x')"
check "recipient lookup finds its account" "/api/recipient?owner=$RECIPIENT" 200 "b['status']=='exists'"

echo "the relay is gone"
for p in "/api/relay/status?tx=$TX" "/api/relay/burns"; do
  code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL$p")"
  [ "$code" = "404" ] && pass "GET $p is 404" || fail "GET $p returned $code (expected 404)"
done
code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL/api/health")"
[ "$code" = "404" ] && pass "GET /api/health (old relay health) is 404" || fail "GET /api/health returned $code (expected 404)"

echo "search engines and assistants"
# head <path> <expected content type prefix>: the status and type, without fetching twice.
served() {
  local label="$1" path="$2" want="$3" res
  res="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 60 -w '%{http_code} %{content_type}' "$BASE_URL$path")"
  case "$res" in "200 $want"*) pass "$label" ;; *) fail "$label: got $res" ;; esac
}
ROBOTS="$(curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL/robots.txt")"
grep -q "Sitemap: https://xebra.exchange/sitemap.xml" <<<"$ROBOTS" && grep -q "ClaudeBot" <<<"$ROBOTS" \
  && pass "robots.txt names the sitemap and allows AI crawlers" \
  || fail "robots.txt: ${ROBOTS:0:120}"
curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL/sitemap.xml" | grep -q "<loc>https://xebra.exchange/bridge/stellar-to-solana</loc>" \
  && pass "the sitemap lists the route pages" || fail "the sitemap has no route pages"
curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL/llms.txt" | head -1 | grep -qx "# Xebra" \
  && pass "llms.txt is served" || fail "llms.txt is missing or malformed"
served "a page's Markdown copy" "/fees.md" "text/markdown"
served "a link-preview image" "/og/home" "image/png"
served "a route page" "/bridge/stellar-to-solana" "text/html"
grep -q 'rel="canonical" href="https://xebra.exchange"' <<<"$HTML" && grep -q 'application/ld+json' <<<"$HTML" \
  && pass "the home page has its canonical URL and structured data" \
  || fail "the home page lacks a canonical URL or JSON-LD"

echo "Iris rate counter"
# Production Convex redacts error messages, so the deployed functions cannot be probed from outside. The app
# reports which counter it is really using instead: `shared` (Convex, seen by every instance) or `local`
# (this instance only: Convex unreachable, or IRIS_BUDGET_SECRET differs between Vercel and Convex).
check "the shared counter is in use" "/api/circle-health?dest=solana" 200 "b['budgetBackend']=='shared'"

echo
if [ "$FAILS" = 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
exit "$FAILS"
