#!/usr/bin/env bash
#
# MAINNET: does Circle's Forwarding Service deliver a real burn between Arc and another EVM chain?
#
# scripts/check-evm-cctp.sh shows the contracts are wired both ways and that Iris quotes forwarding
# for every route. Neither is proof that a burn is actually delivered, and three things the web app
# assumes are still only assumptions until a transfer shows them:
#
#   - that Circle forwards on each of these routes at all
#   - that it keeps the whole max_fee here as it does from Stellar (feeExecuted == maxFee)
#   - that a Fast burn's fee is the quoted fraction of the amount on top of the delivery fee
#
# This makes exactly one burn per run, straight through Circle's TokenMessengerV2 with the same
# arguments the browser sends (apps/web/lib/evm-bridge.ts), and reports what Circle did with it.
# A direction is switched on in NEXT_PUBLIC_ARC_SENDS_TO or NEXT_PUBLIC_ARC_RECEIVES_FROM once it has
# gone through here.
#
# Safeguards:
#   - `check` is read-only and is the default thing to run first; it prints the exact calldata
#   - the amount is capped (MAX_USDC below) and defaults to 1 USDC
#   - there is no default recipient: RECIPIENT must be given, and is validated
#   - `send` refuses unless CONFIRM_SEND_TO repeats the recipient exactly
#   - max_fee is Circle's own `high` quote plus the Fast fee, never less, and is refused above the
#     destination's ceiling or a tenth of the amount: the rules in apps/web/lib/evm-forward-fee.ts
#   - no private key is read from the environment: signing is by a Foundry keystore account
#
# Real money. The burned USDC arrives at the recipient minus Circle's fee. If Circle does NOT
# forward it, the burn is still attested and anyone may submit `receiveMessage` on the destination
# (destination_caller is zero), which is what /claim does. Nothing is lost, only delayed. A Fast
# burn's attestation is good for about a day; /claim asks Circle for a fresh one after that.
#
#   FROM=base TO=arc RECIPIENT=0x... SENDER=0x...                 scripts/test-evm-arc-forwarding-mainnet.sh check
#   FROM=base TO=arc RECIPIENT=0x... CONFIRM_SEND_TO=0x... ACCOUNT=name scripts/test-evm-arc-forwarding-mainnet.sh send
#   FROM=base                                                     scripts/test-evm-arc-forwarding-mainnet.sh status <txhash> [--watch]
#
# Environment:
#   FROM, TO       chain names; exactly one must be `arc`; TO may also be `solana` (from Arc only)
#   RECIPIENT      address on TO that receives               (required for check and send;
#                  for TO=solana a wallet, whose USDC account is derived and opened if missing)
#   SENDER         address that burns                        (check: reads its balance and allowance)
#   ACCOUNT        Foundry keystore account (`cast wallet import`), for `send`
#   PASSWORD_FILE  optional file holding the keystore password; otherwise cast asks
#   AMOUNT_USDC    USDC to burn, up to 6 decimals            (default 1, at most MAX_USDC)
#   SPEED          standard | fast                           (default standard)
#   <CHAIN>_RPC_URL  override an endpoint, e.g. BASE_RPC_URL
#
# Needs: cast (Foundry), curl, python3.

set -euo pipefail

IRIS="https://iris-api.circle.com"

# --- Must match packages/network-config/src/evm-chains.ts. Re-read with scripts/check-evm-cctp.sh. ---
# name | chain id | domain | USDC | default RPC | fast? | max forward fee into it (6-decimal units)
#   | TokenMessengerV2 | MessageTransmitterV2 | TokenMinterV2
CHAINS="
avalanche|43114|1|0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E|https://api.avax.network/ext/bc/C/rpc|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
optimism|10|2|0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85|https://optimism-rpc.publicnode.com|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
arbitrum|42161|3|0xaf88d065e77c8cC2239327C5EDb3A432268e5831|https://arb1.arbitrum.io/rpc|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
base|8453|6|0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913|https://mainnet.base.org|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
polygon|137|7|0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359|https://polygon-bor-rpc.publicnode.com|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
unichain|130|10|0x078D782b760474a361dDA0AF3839290b0EF57AD6|https://mainnet.unichain.org|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
codex|81224|12|0xd996633a415985DBd7D6D12f4A4343E31f5037cf|https://rpc.codex.xyz|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
sonic|146|13|0x29219dd400f2Bf60E5a23d13Be72B486D4038894|https://rpc.soniclabs.com|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
worldchain|480|14|0x79A02482A880bCE3F13e09Da970dC34db4CD24d1|https://worldchain-mainnet.g.alchemy.com/public|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
monad|143|15|0x754704Bc059F8C67012fEd69BC8A327a5aafb603|https://rpc.monad.xyz|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
sei|1329|16|0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392|https://evm-rpc.sei-apis.com|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
xdc|50|18|0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1|https://rpc.xdcrpc.com|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
hyperevm|999|19|0xb88339CB7199b77E23DB6E890353E22632Ba630f|https://rpc.hyperliquid.xyz/evm|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
ink|57073|21|0x2D270e6886d130D724215A266106e6832161EAEd|https://rpc-gel.inkonchain.com|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
ethereum|1|0|0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48|https://ethereum-rpc.publicnode.com|yes|2500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
linea|59144|11|0x176211869cA2b568f2A7D4EE941E073a821EE1ff|https://rpc.linea.build|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
plume|98866|22|0x222365EF19F7947e5484218551B56bb3965Aa7aF|https://rpc.plume.org|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
edge|3343|28|0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c|https://edge-mainnet.g.alchemy.com/public|yes|500000|0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c|0x5b61381Fc9e58E70EfC13a4A97516997019198ee|0x338Dfd607855BeEc17f33e539Ac2479853cC8384
cronos|25|32|0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D|https://evm.cronos.org|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
plasma|9745|33|0x2d661C89D812261039AF9764eceaAee884f5F67F|https://rpc.plasma.to|no|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
xlayer|196|37|0xB6CEceAB302E2E4948951eE7843FC24E92933061|https://rpc.xlayer.tech|yes|500000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
injective|1776|29|0xa00C59fF5a080D2b954d0c75e46E22a0c371235a|https://sentry.evm-rpc.injective.network|no|0|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
morph|2818|30|0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B|https://rpc.morph.network|yes|0|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
pharos|1672|31|0xC879C018dB60520F4355C26eD1a6D572cdAC1815|https://rpc.pharos.xyz|no|0|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
arc|5042|26|0x3600000000000000000000000000000000000000|https://rpc.mainnet.arc.io|no|100000|0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d|0x81D40F21F12A8F0E3252Bccb954D722d4c464B64|0xfd78EE919681417d192449715b2594ab58f5D002
"
CHAIN_NAMES="$(echo "$CHAINS" | cut -d'|' -f1 | xargs) solana"

# Solana, a destination from Arc only. Mirrors SOLANA_FROM_ARC.
SOLANA_DOMAIN=5
SOLANA_CAP=500000
SOLANA_CAP_NEW_ACCOUNT=1000000

# Circle's static "cctp-forward" hook, version 0: "cctp-forward" right-padded to 32 bytes.
FORWARD_HOOK="0x636374702d666f72776172640000000000000000000000000000000000000000"
ZERO32="0x0000000000000000000000000000000000000000000000000000000000000000"
BURN_SIG="depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"
# Arc pays gas in the USDC being burned; this much is left behind. Mirrors ARC_GAS_RESERVE_UNITS.
ARC_GAS_RESERVE=50000

MAX_USDC=10
AMOUNT_USDC="${AMOUNT_USDC:-1}"
SPEED="${SPEED:-standard}"

for tool in cast curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

die() { echo "$*" >&2; exit 1; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }
pad32() { printf '0x%064s' "${1#0x}" | tr ' ' '0' | tr 'A-F' 'a-f'; }
units_to_usdc() { python3 -c "import sys; n=int(sys.argv[1]); print(f'{n//10**6}.{n%10**6:06d}')" "$1"; }
first() { awk '{print $1}'; }

# Sets <prefix>_ID, _DOMAIN, _USDC, _RPC, _FAST, _CAP for a chain name.
load_chain() { # name, prefix
  local row
  row="$(echo "$CHAINS" | grep -E "^$1\|" || true)"
  [ -n "$row" ] || die "unknown chain '$1' (one of: $CHAIN_NAMES)"
  local name id domain usdc rpc fast cap tm mt minter var
  IFS='|' read -r name id domain usdc rpc fast cap tm mt minter <<<"$row"
  var="$(echo "$name" | tr 'a-z' 'A-Z')_RPC_URL"
  printf -v "$2_NAME" '%s' "$name"
  printf -v "$2_ID" '%s' "$id"
  printf -v "$2_DOMAIN" '%s' "$domain"
  printf -v "$2_USDC" '%s' "$usdc"
  printf -v "$2_RPC" '%s' "${!var:-$rpc}"
  printf -v "$2_FAST" '%s' "$fast"
  printf -v "$2_CAP" '%s' "$cap"
  printf -v "$2_TM" '%s' "$tm"
  printf -v "$2_MT" '%s' "$mt"
  printf -v "$2_MINTER" '%s' "$minter"
}

# Solana as a destination: no RPC of ours, no USDC address to call, only its domain and ceilings.
load_solana() {
  DST_NAME=solana DST_DOMAIN=$SOLANA_DOMAIN DST_CAP=$SOLANA_CAP
}

load_route() {
  [ -n "${FROM:-}" ] && [ -n "${TO:-}" ] || die "FROM and TO are required, e.g. FROM=base TO=arc"
  load_chain "$FROM" SRC
  if [ "$TO" = "solana" ]; then
    [ "$SRC_NAME" = "arc" ] || die "only Arc sends to Solana on these routes; got $FROM -> solana"
    load_solana
  else
    load_chain "$TO" DST
  fi
  if [ "$SRC_NAME" = "$DST_NAME" ] || { [ "$SRC_NAME" != "arc" ] && [ "$DST_NAME" != "arc" ]; }; then
    die "exactly one of FROM and TO must be arc; got $FROM -> $TO"
  fi
  case "$SPEED" in
    standard) FINALITY=2000 ;;
    fast)
      [ "$SRC_FAST" = "yes" ] || die "$SRC_NAME has no Fast Transfer; use SPEED=standard"
      FINALITY=1000 ;;
    *) die "SPEED must be standard or fast" ;;
  esac
  AMOUNT="$(python3 -c "
import sys
from decimal import Decimal
a = Decimal(sys.argv[1]) * 10**6
if a != a.to_integral_value() or a <= 0: sys.exit('AMOUNT_USDC must be positive with at most 6 decimals')
if a > Decimal(sys.argv[2]) * 10**6: sys.exit('AMOUNT_USDC is above the cap of ' + sys.argv[2])
print(int(a))" "$AMOUNT_USDC" "$MAX_USDC")"
}

validate_recipient() {
  [ -n "${RECIPIENT:-}" ] || die "RECIPIENT is required: the address on $DST_NAME that receives the USDC"
  if [ "$DST_NAME" = "solana" ]; then validate_solana_recipient; return; fi
  [[ "$RECIPIENT" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "RECIPIENT is not an EVM address: $RECIPIENT"
  RECIPIENT_CS="$(cast to-check-sum-address "$RECIPIENT")"
  RECIPIENT_LC="$(lc "$RECIPIENT")"
  # A mixed-case address carries a checksum; one that fails it has a typo in it.
  if [ "$RECIPIENT" != "$RECIPIENT_LC" ] && [ "$RECIPIENT" != "$RECIPIENT_CS" ]; then
    die "RECIPIENT fails its checksum (there is a typo in it): $RECIPIENT"
  fi
  [[ "$RECIPIENT_LC" =~ ^0x0{36} ]] && die "RECIPIENT is the zero address or a system/burn address"
  for bad in "$DST_USDC" "$DST_TM" "$DST_MT" "$DST_MINTER"; do
    [ "$RECIPIENT_LC" = "$(lc "$bad")" ] && die "RECIPIENT is a contract USDC could never be recovered from: $bad"
  done
  MINT_RECIPIENT="$(pad32 "$RECIPIENT_LC")"
  HOOK="$FORWARD_HOOK"
  OPENS_ACCOUNT=no
}

# A Solana wallet. The mint goes to its USDC token account, never the wallet itself; when that
# account does not exist, Circle opens it during delivery if the hook names the owner, for a
# higher fee with its own ceiling. Same 65 bytes as packages/cctp-evm forwardHookWithAccount.
validate_solana_recipient() {
  command -v node >/dev/null || die "node is needed to derive the Solana token account"
  local out owner_hex ata_hex exists ata_b58
  out="$(node "$(dirname "$0")/resolve-solana-recipient.mjs" "$RECIPIENT")" \
    || die "could not resolve the Solana recipient: $out"
  read -r owner_hex ata_hex exists ata_b58 <<<"$out"
  [[ "$ata_hex" =~ ^[0-9a-f]{64}$ ]] || die "unexpected answer resolving the recipient: $out"
  RECIPIENT_CS="$RECIPIENT (USDC account $ata_b58)"
  MINT_RECIPIENT="0x$ata_hex"
  if [ "$exists" = "true" ]; then
    HOOK="$FORWARD_HOOK"
    OPENS_ACCOUNT=no
  else
    HOOK="${FORWARD_HOOK:0:50}000000000000002101$owner_hex"
    OPENS_ACCOUNT=yes
    DST_CAP=$SOLANA_CAP_NEW_ACCOUNT
  fi
}

# Sets FORWARD_FEE, SPEED_FEE, MAX_FEE from Iris, applying the web app's rules.
price() {
  local body
  local setup=""
  [ "${OPENS_ACCOUNT:-no}" = "yes" ] && setup="&includeRecipientSetup=true"
  body="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$SRC_DOMAIN/$DST_DOMAIN?forward=true$setup")" \
    || die "Iris did not answer the fee quote for $SRC_DOMAIN -> $DST_DOMAIN"
  local priced
  # Assigned first, so a refusal from the pricing rules stops the script instead of leaving the
  # three figures empty for the lines below to trip over.
  priced="$(echo "$body" | python3 -c '
import sys, json
finality, amount, cap = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
rows = json.load(sys.stdin)
row = next((r for r in rows if r.get("finalityThreshold") == finality), None)
if not row or not isinstance(row.get("forwardFee"), dict):
    sys.exit(f"Iris is not quoting forwarding at finality {finality} on this route")
high = row["forwardFee"]["high"]
scaled = (row.get("minimumFee") or 0) * 100_000          # basis points -> parts per billion
ppb = round(scaled)
if abs(scaled - ppb) > 1e-6: sys.exit("Iris minimumFee cannot be made exact")
speed = -(-amount * ppb // 10**9)                         # rounded up
total = high + speed
if high > cap: sys.exit(f"delivery fee {high} is above the ceiling for this destination ({cap})")
if total * 10 > amount: sys.exit(f"fees ({total}) would be more than a tenth of the amount ({amount}); send more")
print(high, speed, total)' "$FINALITY" "$AMOUNT" "$DST_CAP")" || exit 1
  read -r FORWARD_FEE SPEED_FEE MAX_FEE <<<"$priced"
  [[ "$MAX_FEE" =~ ^[0-9]+$ ]] || die "could not price the transfer"
}

burn_args() {
  BURN_ARGS=("$AMOUNT" "$DST_DOMAIN" "$MINT_RECIPIENT" "$SRC_USDC" "$ZERO32" "$MAX_FEE" "$FINALITY" "$HOOK")
}

summary() {
  echo "Route        $SRC_NAME (domain $SRC_DOMAIN) -> $DST_NAME (domain $DST_DOMAIN), $SPEED (finality $FINALITY)"
  echo "Amount       $(units_to_usdc "$AMOUNT") USDC"
  echo "Delivery fee $(units_to_usdc "$FORWARD_FEE") USDC  (Iris high, 1.0x)"
  echo "Speed fee    $(units_to_usdc "$SPEED_FEE") USDC"
  echo "max_fee      $(units_to_usdc "$MAX_FEE") USDC  ($MAX_FEE units)"
  echo "Recipient    $RECIPIENT_CS  should receive $(units_to_usdc "$((AMOUNT - MAX_FEE))") USDC"
  [ "${OPENS_ACCOUNT:-no}" = "yes" ] && echo "             Circle also opens the recipient's USDC account (65-byte hook)"
  return 0
}

cmd_check() {
  load_route; validate_recipient
  local got
  got="$(cast chain-id --rpc-url "$SRC_RPC")"
  [ "$got" = "$SRC_ID" ] || die "$SRC_RPC answered as chain $got, expected $SRC_ID"
  if [ "$DST_NAME" != "solana" ]; then
    got="$(cast chain-id --rpc-url "$DST_RPC")"
    [ "$got" = "$DST_ID" ] || die "$DST_RPC answered as chain $got, expected $DST_ID"
  fi
  price; burn_args; summary
  echo
  echo "Calldata to TokenMessengerV2 $SRC_TM on $SRC_NAME:"
  cast calldata "$BURN_SIG" "${BURN_ARGS[@]}"
  if [ -n "${SENDER:-}" ]; then
    local bal allow
    bal="$(cast call "$SRC_USDC" 'balanceOf(address)(uint256)' "$SENDER" --rpc-url "$SRC_RPC" | first)"
    allow="$(cast call "$SRC_USDC" 'allowance(address,address)(uint256)' "$SENDER" "$SRC_TM" --rpc-url "$SRC_RPC" | first)"
    echo
    echo "Sender       $SENDER holds $(units_to_usdc "$bal") USDC on $SRC_NAME; allowance to Circle $(units_to_usdc "$allow")"
    [ "$bal" -ge "$AMOUNT" ] || echo "             NOT ENOUGH: the burn needs $(units_to_usdc "$AMOUNT")"
    if [ "$SRC_NAME" = "arc" ] && [ "$((bal - AMOUNT))" -lt "$ARC_GAS_RESERVE" ]; then
      echo "             Arc pays gas in USDC: leave at least $(units_to_usdc "$ARC_GAS_RESERVE") behind"
    fi
    if [ "$allow" -ge "$AMOUNT" ]; then
      echo -n "Simulation   "
      cast call "$SRC_TM" "$BURN_SIG" "${BURN_ARGS[@]}" --from "$SENDER" --rpc-url "$SRC_RPC" >/dev/null \
        && echo "the burn would succeed" || echo "the burn would FAIL (see above)"
    else
      echo "Simulation   skipped: \`send\` approves $(units_to_usdc "$AMOUNT") USDC first"
    fi
  fi
  echo
  echo "Nothing was sent. To send: add CONFIRM_SEND_TO=$RECIPIENT ACCOUNT=<keystore account> and run \`send\`."
}

signer() {
  [ -n "${ACCOUNT:-}" ] || die "ACCOUNT is required: a Foundry keystore account (cast wallet import <name> --interactive)"
  SIGNER=(--account "$ACCOUNT")
  [ -n "${PASSWORD_FILE:-}" ] && SIGNER+=(--password-file "$PASSWORD_FILE")
  return 0
}

tx_hash() { python3 -c 'import sys, json; print(json.load(sys.stdin)["transactionHash"])'; }

cmd_send() {
  load_route; validate_recipient; signer
  [ "${CONFIRM_SEND_TO:-}" = "$RECIPIENT" ] \
    || die "refusing to send: set CONFIRM_SEND_TO to the recipient exactly ($RECIPIENT) to confirm a real burn"
  local sender bal allow hash
  sender="$(cast wallet address "${SIGNER[@]}")"
  [ "$(cast chain-id --rpc-url "$SRC_RPC")" = "$SRC_ID" ] || die "$SRC_RPC is not chain $SRC_ID"
  price; burn_args; summary
  echo "Sender       $sender"

  bal="$(cast call "$SRC_USDC" 'balanceOf(address)(uint256)' "$sender" --rpc-url "$SRC_RPC" | first)"
  [ "$bal" -ge "$AMOUNT" ] || die "the sender holds $(units_to_usdc "$bal") USDC on $SRC_NAME; the burn needs $(units_to_usdc "$AMOUNT")"
  if [ "$SRC_NAME" = "arc" ] && [ "$((bal - AMOUNT))" -lt "$ARC_GAS_RESERVE" ]; then
    die "Arc pays gas in USDC: leave at least $(units_to_usdc "$ARC_GAS_RESERVE") in the wallet"
  fi

  allow="$(cast call "$SRC_USDC" 'allowance(address,address)(uint256)' "$sender" "$SRC_TM" --rpc-url "$SRC_RPC" | first)"
  if [ "$allow" -lt "$AMOUNT" ]; then
    echo; echo "Approving $(units_to_usdc "$AMOUNT") USDC to TokenMessengerV2 (1 of 2)…"
    hash="$(cast send "$SRC_USDC" 'approve(address,uint256)' "$SRC_TM" "$AMOUNT" \
      --rpc-url "$SRC_RPC" "${SIGNER[@]}" --json | tx_hash)"
    echo "Approval     $hash"
  fi

  echo; echo "Simulating the burn as the sender…"
  cast call "$SRC_TM" "$BURN_SIG" "${BURN_ARGS[@]}" --from "$sender" --rpc-url "$SRC_RPC" >/dev/null \
    || die "the burn would fail; nothing was burned"

  echo "Burning (2 of 2)…"
  hash="$(cast send "$SRC_TM" "$BURN_SIG" "${BURN_ARGS[@]}" \
    --rpc-url "$SRC_RPC" "${SIGNER[@]}" --json | tx_hash)"
  echo
  echo "Burn transaction: $hash"
  echo "Watching Circle. To watch again later:  FROM=$SRC_NAME $0 status $hash --watch"
  echo
  cmd_status "$hash" --watch
}

cmd_status() {
  local hash="${1:-}" watch="${2:-}"
  [[ "$hash" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "usage: FROM=<chain> $0 status <0x tx hash> [--watch]"
  [ -n "${SRC_DOMAIN:-}" ] || { [ -n "${FROM:-}" ] || die "FROM is required: the chain the burn was made on"; load_chain "$FROM" SRC; }
  local started i=0 verdict
  started="$(date +%s)"
  while :; do
    echo "--- $(date +%H:%M:%S)  +$(( $(date +%s) - started ))s  Iris mainnet, source domain $SRC_DOMAIN"
    verdict="$(curl -s -m 20 "$IRIS/v2/messages/$SRC_DOMAIN?transactionHash=$hash" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  (no JSON yet:", e, ")"); print("WAIT"); sys.exit(0)
msgs = d.get("messages") or []
if not msgs:
    print("  no message yet:", json.dumps(d)[:160]); print("WAIT"); sys.exit(0)
m = msgs[0]
print("  status             ", m.get("status"))
for k in ("forwardState", "forwardErrorCode", "forwardErrorDetails", "forwardTxHash", "delayReason"):
    if m.get(k) is not None: print(f"  {k:<19}", m[k])
body = (m.get("decodedMessage") or {}).get("decodedMessageBody") or {}
for k in ("amount", "maxFee", "feeExecuted", "expirationBlock", "mintRecipient"):
    if k in body: print(f"  {k:<19}", str(body[k])[:80])
if body.get("maxFee") is not None and body.get("feeExecuted") is not None:
    same = str(body["maxFee"]) == str(body["feeExecuted"])
    print("  whole max_fee kept ", "yes" if same else "NO: feeExecuted differs from maxFee")
state = str(m.get("forwardState") or "").upper()
print("DONE" if state in ("COMPLETE", "FAILED") else "WAIT")' || echo "WAIT")"
    echo "$verdict" | sed '$d'
    if [ "$(echo "$verdict" | tail -1)" = "DONE" ]; then
      echo
      echo "Circle reached a verdict after $(( $(date +%s) - started ))s of watching. COMPLETE with a forwardTxHash means it was delivered on MAINNET."
      return 0
    fi
    [ "$watch" = "--watch" ] || return 0
    i=$((i + 1))
    if [ "$i" -ge 160 ]; then echo "gave up after ~40 minutes; see forwardState above. The burn is still claimable at /claim."; return 1; fi
    sleep 15
  done
}

case "${1:-}" in
  check) cmd_check ;;
  send) cmd_send ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
