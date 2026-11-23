#!/usr/bin/env bash
#
# Re-verifies, against the live chains, every constant the EVM <-> Arc routes rest on.
#
# On these routes the browser calls Circle's TokenMessengerV2 directly. There is no Xebra contract
# to refuse a wrong domain or a wrong token, so the table in packages/network-config/src/evm-chains.ts
# is the whole of the safety, and this is that table read back from the chains. Circle can
# redeploy, and the three contract addresses are identical on every chain, so a stale or
# mistyped row would still answer.
#
# Asserts, for each EVM chain offered with Arc (every one Circle forwards to from Arc except
# Ethereum, Linea, Plume and EDGE, left out on purpose), and Arc itself:
#   - the endpoint answers as the pinned chain id
#   - TokenMessengerV2 / MessageTransmitterV2 carry code, and the messenger points at the
#     transmitter and minter pinned for that chain
#   - MessageTransmitterV2.localDomain() is the pinned CCTP domain and it is not paused
#   - depositForBurnWithHook's selector (0x779b432d) is in the messenger's implementation bytecode
#   - the pinned USDC is a 6-decimal token
# and for each chain paired with Arc:
#   - each side holds the other's TokenMessengerV2 as its remote, byte for byte
#   - each side's TokenMinter maps the other's USDC to its own
#   - Circle's Iris prices forwarding in both directions
# and that Arc knows Solana's messenger and Iris prices Arc -> Solana, with and without opening
# the recipient's USDC account.
#
# Requires `cast` (Foundry), curl and python3. Read-only: nothing is signed.
#
# Usage:  scripts/check-evm-cctp.sh            (pnpm check:evm)
# Override an endpoint with <CHAIN>_RPC_URL, e.g. BASE_RPC_URL=https://...
# Exits non-zero on any drift.

set -euo pipefail

IRIS="${IRIS_BASE_URL:-https://iris-api.circle.com}"

# Pinned values — must match packages/network-config/src/evm-chains.ts.
# cast sig "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"
BURN_WITH_HOOK_SELECTOR="779b432d"

# name | chain id | domain | USDC | default RPC | TokenMessengerV2 | MessageTransmitterV2 | TokenMinterV2
# All share Circle's one address set today; each row names its own because not every Circle chain
# does (EDGE, left out, has its own).
CHAINS="
avalanche|43114|1|0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E|https://api.avax.network/ext/bc/C/rpc|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
optimism|10|2|0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85|https://optimism-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
arbitrum|42161|3|0xaf88d065e77c8cC2239327C5EDb3A432268e5831|https://arb1.arbitrum.io/rpc|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
base|8453|6|0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913|https://mainnet.base.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
polygon|137|7|0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359|https://polygon-bor-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
unichain|130|10|0x078D782b760474a361dDA0AF3839290b0EF57AD6|https://mainnet.unichain.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
codex|81224|12|0xd996633a415985DBd7D6D12f4A4343E31f5037cf|https://rpc.codex.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
sonic|146|13|0x29219dd400f2Bf60E5a23d13Be72B486D4038894|https://rpc.soniclabs.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
worldchain|480|14|0x79A02482A880bCE3F13e09Da970dC34db4CD24d1|https://worldchain-mainnet.g.alchemy.com/public|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
monad|143|15|0x754704Bc059F8C67012fEd69BC8A327a5aafb603|https://rpc.monad.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
sei|1329|16|0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392|https://evm-rpc.sei-apis.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
xdc|50|18|0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1|https://rpc.xdcrpc.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
hyperevm|999|19|0xb88339CB7199b77E23DB6E890353E22632Ba630f|https://rpc.hyperliquid.xyz/evm|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
ink|57073|21|0x2D270e6886d130D724215A266106e6832161EAEd|https://rpc-gel.inkonchain.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
ethereum|1|0|0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48|https://ethereum-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
linea|59144|11|0x176211869cA2b568f2A7D4EE941E073a821EE1ff|https://rpc.linea.build|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
plume|98866|22|0x222365EF19F7947e5484218551B56bb3965Aa7aF|https://rpc.plume.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
edge|3343|28|0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c|https://edge-mainnet.g.alchemy.com/public|0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c|0x5b61381Fc9e58E70EfC13a4A97516997019198ee|0x338Dfd607855BeEc17f33e539Ac2479853cC8384
cronos|25|32|0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D|https://evm.cronos.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
plasma|9745|33|0x2d661C89D812261039AF9764eceaAee884f5F67F|https://rpc.plasma.to|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
xlayer|196|37|0xB6CEceAB302E2E4948951eE7843FC24E92933061|https://rpc.xlayer.tech|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
injective|1776|29|0xa00C59fF5a080D2b954d0c75e46E22a0c371235a|https://sentry.evm-rpc.injective.network|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
morph|2818|30|0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B|https://rpc.morph.network|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
pharos|1672|31|0xC879C018dB60520F4355C26eD1a6D572cdAC1815|https://rpc.pharos.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
arc|5042|26|0x3600000000000000000000000000000000000000|https://rpc.mainnet.arc.io|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
"
ARC_TOKEN_MESSENGER="0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"
# Solana's TokenMessengerMinterV2 program as Arc holds it for domain 5 (packages/network-config).
SOLANA_DOMAIN=5
SOLANA_TOKEN_MESSENGER="0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893"
ARC_DOMAIN=26
ARC_USDC="0x3600000000000000000000000000000000000000"

for tool in cast curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

fail=0
check() { # name, expected, actual
  if [ "$(echo "$2" | tr 'A-F' 'a-f')" = "$(echo "$3" | tr 'A-F' 'a-f')" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected %s\n        got      %s\n' "$1" "$2" "$3"
    fail=1
  fi
}
pad32() { printf '0x%064s' "${1#0x}" | tr ' ' '0'; }
rpc_for() { # name, default
  local var; var="$(echo "$1" | tr 'a-z' 'A-Z')_RPC_URL"
  echo "${!var:-$2}"
}
# One retry: public endpoints drop the odd request, and a dropped read is not drift.
rd() { # rpc, cast subcommand...
  local rpc="$1"; shift
  timeout 30 cast "$@" --rpc-url "$rpc" 2>/dev/null \
    || { sleep 2; timeout 30 cast "$@" --rpc-url "$rpc" 2>/dev/null; } \
    || echo "unreachable"
}
first() { awk '{print $1}'; }

arc_rpc="$(rpc_for arc https://rpc.mainnet.arc.io)"
arc_minter="$(rd "$arc_rpc" call "$ARC_TOKEN_MESSENGER" 'localMinter()(address)')"

while IFS='|' read -r name chain_id domain usdc default_rpc TOKEN_MESSENGER MESSAGE_TRANSMITTER TOKEN_MINTER; do
  [ -n "$name" ] || continue
  rpc="$(rpc_for "$name" "$default_rpc")"
  echo "$name ($rpc)"

  check "chain id is $chain_id" "$chain_id" "$(rd "$rpc" chain-id)"
  for pair in "TokenMessengerV2:$TOKEN_MESSENGER" "MessageTransmitterV2:$MESSAGE_TRANSMITTER"; do
    code="$(rd "$rpc" code "${pair#*:}")"
    check "${pair%%:*} has code" "yes" "$([ "${#code}" -gt 12 ] && echo yes || echo no)"
  done
  check "localDomain() is $domain" "$domain" \
    "$(rd "$rpc" call "$MESSAGE_TRANSMITTER" 'localDomain()(uint32)' | first)"
  check "MessageTransmitterV2 is not paused" "false" \
    "$(rd "$rpc" call "$MESSAGE_TRANSMITTER" 'paused()(bool)')"
  check "TokenMessengerV2 points at this MessageTransmitter" "$MESSAGE_TRANSMITTER" \
    "$(rd "$rpc" call "$TOKEN_MESSENGER" 'localMessageTransmitter()(address)')"
  check "TokenMessengerV2 mints through this TokenMinter" "$TOKEN_MINTER" \
    "$(rd "$rpc" call "$TOKEN_MESSENGER" 'localMinter()(address)')"

  impl="$(rd "$rpc" implementation "$TOKEN_MESSENGER")"
  impl_code="$(rd "$rpc" code "$impl")"
  check "depositForBurnWithHook (0x$BURN_WITH_HOOK_SELECTOR) is in the implementation" "yes" \
    "$(echo "$impl_code" | grep -qi "$BURN_WITH_HOOK_SELECTOR" && echo yes || echo no)"

  check "USDC has 6 decimals" "6" "$(rd "$rpc" call "$usdc" 'decimals()(uint8)' | first)"
  check "USDC is called USDC" '"USDC"' "$(rd "$rpc" call "$usdc" 'symbol()(string)')"

  if [ "$name" != "arc" ]; then
    check "$name holds Arc's TokenMessengerV2 as domain $ARC_DOMAIN" "$(pad32 "$ARC_TOKEN_MESSENGER")" \
      "$(rd "$rpc" call "$TOKEN_MESSENGER" 'remoteTokenMessengers(uint32)(bytes32)' "$ARC_DOMAIN")"
    check "Arc holds $name's TokenMessengerV2 as domain $domain" "$(pad32 "$TOKEN_MESSENGER")" \
      "$(rd "$arc_rpc" call "$ARC_TOKEN_MESSENGER" 'remoteTokenMessengers(uint32)(bytes32)' "$domain")"

    check "$name's TokenMinter maps Arc USDC to its own" "$usdc" \
      "$(rd "$rpc" call "$TOKEN_MINTER" 'getLocalToken(uint32,bytes32)(address)' "$ARC_DOMAIN" "$(pad32 "$ARC_USDC")")"
    check "Arc's TokenMinter maps $name USDC to Arc USDC" "$ARC_USDC" \
      "$(rd "$arc_rpc" call "$arc_minter" 'getLocalToken(uint32,bytes32)(address)' "$domain" "$(pad32 "$usdc")")"

    routes="$domain/$ARC_DOMAIN $ARC_DOMAIN/$domain"
    # Circle does not deliver to Injective (29), Morph (30) or Pharos (31): only out of them.
    case "$domain" in 29|30|31) routes="$domain/$ARC_DOMAIN" ;; esac
    for route in $routes; do
      quote="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$route?forward=true" || echo '[]')"
      check "Iris prices forwarding for $route at both finality thresholds" "2" \
        "$(echo "$quote" | python3 -c '
import sys, json
rows = json.load(sys.stdin)
print(sum(1 for r in rows if isinstance(r.get("forwardFee"), dict) and r["forwardFee"].get("high", 0) > 0))')"
      sleep 0.2
    done
  fi
done <<EOF
$CHAINS
EOF

echo "solana (destination from Arc only)"
check "Arc holds Solana's TokenMessengerMinter as domain $SOLANA_DOMAIN" "$SOLANA_TOKEN_MESSENGER" \
  "$(rd "$arc_rpc" call "$ARC_TOKEN_MESSENGER" 'remoteTokenMessengers(uint32)(bytes32)' "$SOLANA_DOMAIN")"
for setup in "" "&includeRecipientSetup=true"; do
  quote="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$ARC_DOMAIN/$SOLANA_DOMAIN?forward=true$setup" || echo '[]')"
  check "Iris prices forwarding for $ARC_DOMAIN/$SOLANA_DOMAIN${setup:+ with account creation}" "2" \
    "$(echo "$quote" | python3 -c '
import sys, json
rows = json.load(sys.stdin)
print(sum(1 for r in rows if isinstance(r.get("forwardFee"), dict) and r["forwardFee"].get("high", 0) > 0))')"
done

if [ "$fail" -ne 0 ]; then
  echo; echo "DRIFT: at least one EVM route constant no longer matches the chain." >&2
  echo "Do not deploy. Re-read the values and update packages/network-config/src/evm-chains.ts." >&2
  exit 1
fi
echo; echo "EVM route constants agree with the live chains."
