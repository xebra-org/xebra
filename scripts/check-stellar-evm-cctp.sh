#!/usr/bin/env bash
#
# Re-verifies, against the live chains, what a transfer from Stellar to each EVM chain in the table
# rests on, before the wrapper is asked to commit that chain's domain.
#
# Stellar sends through the wrapper (contracts/stellar-cctp-wrapper-v2), which needs no change for a
# new EVM domain: the admin proposes it, waits 48 hours, and commits it. What has to be true first
# is on Circle's side, and this reads it back:
#   - Stellar's TokenMessengerMinter holds the chain's TokenMessengerV2 as that domain, left-padded
#   - the chain's TokenMessengerV2 holds Stellar's TokenMessengerMinter as domain 27, byte for byte
#   - the chain's TokenMinter maps Stellar USDC to the chain's pinned USDC
#   - Circle's Iris prices forwarding 27 -> domain at Standard (the only speed Stellar has), with a
#     delivery fee under the cap the domain has (or would have) on the wrapper
# and reports, for information, which domains the wrapper has committed today.
#
# Arc (26) is included for completeness; scripts/check-arc-cctp.sh checks that corridor in more
# depth. An EVM endpoint that does not answer is reported as skipped, not as drift: public RPCs
# drop requests, and the Stellar and Iris reads still cover the route. Re-run, or set
# <CHAIN>_RPC_URL, to read it.
#
# Requires `cast` (Foundry), the `stellar` CLI, curl and python3. Read-only: nothing is signed.
#
# Usage:  scripts/check-stellar-evm-cctp.sh        (part of pnpm check:evm)
# Env:    STELLAR_READ_ACCOUNT  any local identity, used only as a simulation source (default alice)
#         PROPOSED_CAP_UNITS    the cap a domain not yet committed would be proposed with, in
#                               6-decimal units (default 250000, the admin panel's 0.25 USDC)
# Exits non-zero on any drift.

set -euo pipefail

SOROBAN_RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
PASSPHRASE="Public Global Stellar Network ; September 2015"
IRIS="${IRIS_BASE_URL:-https://iris-api.circle.com}"
READ_ACCOUNT="${STELLAR_READ_ACCOUNT:-alice}"
PROPOSED_CAP_UNITS="${PROPOSED_CAP_UNITS:-250000}"
STELLAR_DOMAIN=27

# Pinned values — must match packages/network-config (networks.ts and evm-chains.ts).
STELLAR_TOKEN_MESSENGER="CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL"
STELLAR_USDC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="${WRAPPER_CONTRACT_ID:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cctpWrapperV2"]["contractId"])' "$ROOT/deployments/mainnet.json")}"

# name | domain | USDC | default RPC | TokenMessengerV2 | TokenMinterV2
CHAINS="
avalanche|1|0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E|https://api.avax.network/ext/bc/C/rpc|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
optimism|2|0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85|https://optimism-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
arbitrum|3|0xaf88d065e77c8cC2239327C5EDb3A432268e5831|https://arb1.arbitrum.io/rpc|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
base|6|0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913|https://mainnet.base.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
polygon|7|0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359|https://polygon-bor-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
unichain|10|0x078D782b760474a361dDA0AF3839290b0EF57AD6|https://mainnet.unichain.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
codex|12|0xd996633a415985DBd7D6D12f4A4343E31f5037cf|https://rpc.codex.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
sonic|13|0x29219dd400f2Bf60E5a23d13Be72B486D4038894|https://rpc.soniclabs.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
worldchain|14|0x79A02482A880bCE3F13e09Da970dC34db4CD24d1|https://worldchain-mainnet.g.alchemy.com/public|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
monad|15|0x754704Bc059F8C67012fEd69BC8A327a5aafb603|https://rpc.monad.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
sei|16|0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392|https://evm-rpc.sei-apis.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
xdc|18|0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1|https://rpc.xdcrpc.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
hyperevm|19|0xb88339CB7199b77E23DB6E890353E22632Ba630f|https://rpc.hyperliquid.xyz/evm|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
ink|21|0x2D270e6886d130D724215A266106e6832161EAEd|https://rpc-gel.inkonchain.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
ethereum|0|0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48|https://ethereum-rpc.publicnode.com|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
linea|11|0x176211869cA2b568f2A7D4EE941E073a821EE1ff|https://rpc.linea.build|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
plume|22|0x222365EF19F7947e5484218551B56bb3965Aa7aF|https://rpc.plume.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
edge|28|0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c|https://edge-mainnet.g.alchemy.com/public|0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c|0x338Dfd607855BeEc17f33e539Ac2479853cC8384
cronos|32|0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D|https://evm.cronos.org|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
plasma|33|0x2d661C89D812261039AF9764eceaAee884f5F67F|https://rpc.plasma.to|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
xlayer|37|0xB6CEceAB302E2E4948951eE7843FC24E92933061|https://rpc.xlayer.tech|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
injective|29|0xa00C59fF5a080D2b954d0c75e46E22a0c371235a|https://sentry.evm-rpc.injective.network|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
morph|30|0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B|https://rpc.morph.network|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
pharos|31|0xC879C018dB60520F4355C26eD1a6D572cdAC1815|https://rpc.pharos.xyz|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
arc|26|0x3600000000000000000000000000000000000000|https://rpc.mainnet.arc.io|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0xfd78EE919681417d192449715b2594ab58f5D002
"

for tool in cast stellar curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

fail=0
skipped=0
check() { # name, expected, actual
  if [ "$3" = "unreachable" ]; then
    printf '  skip  %s (endpoint did not answer)\n' "$1"
    skipped=$((skipped + 1))
  elif [ "$(echo "$2" | tr 'A-F' 'a-f')" = "$(echo "$3" | tr 'A-F' 'a-f')" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected %s\n        got      %s\n' "$1" "$2" "$3"
    fail=1
  fi
}
pad32() { printf '0x%064s' "${1#0x}" | tr ' ' '0'; }
strkey_hex() { stellar strkey decode "$1" | python3 -c 'import sys,json; print("0x"+json.load(sys.stdin)["contract"])'; }
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
sinvoke() { # contract, fn, args...
  local id="$1"; shift
  stellar contract invoke --id "$id" --rpc-url "$SOROBAN_RPC" --network-passphrase "$PASSPHRASE" \
    --source-account "$READ_ACCOUNT" --send no -- "$@" 2>/dev/null
}
# What Stellar's TokenMessengerMinter holds for a domain, as 0x-prefixed hex.
stellar_remote() { # domain
  local v
  v="$(sinvoke "$STELLAR_TOKEN_MESSENGER" get_remote_token_messenger --domain "$1" | tr -d '"')" || v=""
  if [ -n "$v" ]; then echo "0x$v"; else echo "no answer"; fi
}

stellar_tm_hex="$(strkey_hex "$STELLAR_TOKEN_MESSENGER")"
stellar_usdc_hex="$(strkey_hex "$STELLAR_USDC")"

# The wrapper's committed domains and their caps, as `domain cap_units` lines (stroops / 10).
domains_json="$(sinvoke "$WRAPPER" get_domains)" || {
  echo "could not read get_domains on $WRAPPER (is STELLAR_READ_ACCOUNT=$READ_ACCOUNT a local identity?)" >&2
  exit 2
}
committed="$(echo "$domains_json" | python3 -c '
import sys, json
for d in json.load(sys.stdin):
    print(d["domain"], int(d["max_forward_fee"]) // 10)')"
echo "Wrapper $WRAPPER commits domains: $(echo "$committed" | awk '{print $1}' | tr '\n' ' ')"

while IFS='|' read -r name domain usdc default_rpc TOKEN_MESSENGER TOKEN_MINTER; do
  [ -n "$name" ] || continue
  rpc="$(rpc_for "$name" "$default_rpc")"
  cap="$(echo "$committed" | awk -v d="$domain" '$1 == d {print $2}')"
  if [ -n "$cap" ]; then
    echo "$name (domain $domain, committed, cap $cap)"
  else
    echo "$name (domain $domain, not committed, would be proposed at a cap of $PROPOSED_CAP_UNITS)"
    cap="$PROPOSED_CAP_UNITS"
  fi

  check "Stellar holds $name's TokenMessengerV2 as domain $domain" "$(pad32 "$TOKEN_MESSENGER")" \
    "$(stellar_remote "$domain")"
  check "$name holds Stellar's TokenMessengerMinter as domain $STELLAR_DOMAIN" "$stellar_tm_hex" \
    "$(rd "$rpc" call "$TOKEN_MESSENGER" 'remoteTokenMessengers(uint32)(bytes32)' "$STELLAR_DOMAIN")"
  check "$name's TokenMinter maps Stellar USDC to its own" "$usdc" \
    "$(rd "$rpc" call "$TOKEN_MINTER" 'getLocalToken(uint32,bytes32)(address)' "$STELLAR_DOMAIN" "$stellar_usdc_hex")"

  quote="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$STELLAR_DOMAIN/$domain?forward=true" || echo '[]')"
  high="$(echo "$quote" | python3 -c '
import sys, json
rows = [r for r in json.load(sys.stdin) if r.get("finalityThreshold") == 2000]
fee = rows[0].get("forwardFee") if rows else None
print(fee["high"] if isinstance(fee, dict) and fee.get("high", 0) > 0 else "none")')"
  check "Iris prices forwarding $STELLAR_DOMAIN/$domain at Standard" "yes" "$([ "$high" != none ] && echo yes || echo no)"
  if [ "$high" != none ]; then
    check "Standard delivery fee $high is under the cap $cap" "yes" "$([ "$high" -le "$cap" ] && echo yes || echo no)"
  fi
  sleep 0.2
done <<EOF
$CHAINS
EOF

if [ "$fail" -ne 0 ]; then
  echo; echo "DRIFT: at least one Stellar -> EVM constant no longer matches the chain." >&2
  echo "Do not commit that domain. Re-read the values and update packages/network-config." >&2
  exit 1
fi
echo
if [ "$skipped" -ne 0 ]; then
  echo "Stellar -> EVM constants agree with the live chains; $skipped EVM read(s) skipped, endpoint did not answer."
else
  echo "Stellar -> EVM constants agree with the live chains."
fi
