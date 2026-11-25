#!/usr/bin/env bash
#
# Adds Sui (CCTP domain 8) to the mainnet Stellar wrapper v2, as a NON-forwarded destination.
#
# Circle's Forwarding Service does not deliver to Sui (Iris refuses a forward quote 27 -> 8), so the
# wrapper burns with no hook and destination_caller zero, and the recipient mints at /claim with any
# Sui wallet. The config:
#
#   domain 8, evm_style false (a Sui address is 32 bytes, not a padded EVM one), forward false,
#   max_forward_fee 0, account_creation false, max_forward_fee_new_account 0
#
# The wrapper has ONE pending-domain slot. Proposing Sui while another proposal is pending replaces
# it. So the steps are, in order:
#
#   status            what is committed and what is pending (read-only)
#   commit-pending    commit whatever is pending, if its 48 h timelock has run out
#   propose-sui       propose Sui; refuses while anything else is pending
#   commit-sui        commit Sui, 48 h after propose-sui
#
# Every step simulates unless SEND=1. Signs with the Stellar CLI key `xebra-admin` (the wrapper's
# admin), so no secret is ever printed.
#
#   scripts/wrapper-sui-domain.sh status
#   SEND=1 scripts/wrapper-sui-domain.sh commit-pending
#   SEND=1 scripts/wrapper-sui-domain.sh propose-sui
#   SEND=1 scripts/wrapper-sui-domain.sh commit-sui        # 48 h later

set -euo pipefail

WRAPPER="${WRAPPER:-CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR}"
RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
PASSPHRASE="Public Global Stellar Network ; September 2015"
ADMIN_KEY="${ADMIN_KEY:-xebra-admin}"
SEND_FLAG="--send=no"
[[ "${SEND:-}" == "1" ]] && SEND_FLAG="--send=yes"

SUI_CFG='{"domain":8,"evm_style":false,"forward":false,"max_forward_fee":"0","account_creation":false,"max_forward_fee_new_account":"0"}'

invoke() {
  stellar contract invoke --id "$WRAPPER" --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" \
    --source-account "$ADMIN_KEY" "$@"
}

# Prints "<domain> <eta>" for the pending proposal, or nothing. There is no getter for it, so it is
# read from the contract's instance storage.
pending() {
  stellar contract read --id "$WRAPPER" --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" \
    --durability persistent --key-xdr AAAAFA== --output json 2>/dev/null |
    python3 -I -c '
import csv, json, sys
row = next(csv.reader(sys.stdin))
for e in json.loads(row[1])["contract_instance"]["storage"]:
    k = e["key"]
    if "vec" in k and k["vec"][0].get("symbol") == "PendingDomain":
        m = {x["key"]["symbol"]: x["val"] for x in e["val"]["map"]}
        cfg = {x["key"]["symbol"]: x["val"] for x in m["cfg"]["map"]}
        print(cfg["domain"]["u32"], m["eta"]["u64"])
'
}

committed_has_sui() {
  invoke --send=no -- get_domains | grep -q '"domain":8,'
}

case "${1:-status}" in
  status)
    echo "Committed:"
    invoke --send=no -- get_domains
    p="$(pending)"
    if [[ -z "$p" ]]; then
      echo "Pending: none"
    else
      read -r domain eta <<<"$p"
      echo "Pending: domain $domain, committable from $(date -u -d "@$eta" '+%Y-%m-%d %H:%M UTC')"
    fi
    ;;
  commit-pending)
    p="$(pending)"
    [[ -z "$p" ]] && { echo "Nothing pending."; exit 0; }
    read -r domain eta <<<"$p"
    now="$(date -u +%s)"
    if ((now < eta)); then
      echo "Domain $domain is not committable until $(date -u -d "@$eta" '+%Y-%m-%d %H:%M UTC')." >&2
      exit 1
    fi
    echo "Committing domain $domain ($SEND_FLAG)"
    invoke "$SEND_FLAG" -- commit_domain
    ;;
  propose-sui)
    if committed_has_sui; then
      echo "Sui (8) is already committed." >&2
      exit 1
    fi
    p="$(pending)"
    if [[ -n "$p" ]]; then
      read -r domain _ <<<"$p"
      if [[ "$domain" != "8" ]]; then
        echo "Domain $domain is pending; proposing Sui would replace it. Run commit-pending first." >&2
        exit 1
      fi
      echo "Sui is already pending." >&2
      exit 1
    fi
    echo "Proposing Sui ($SEND_FLAG): $SUI_CFG"
    invoke "$SEND_FLAG" -- propose_domain --cfg "$SUI_CFG"
    ;;
  commit-sui)
    p="$(pending)"
    read -r domain _ <<<"${p:-none 0}"
    if [[ "$domain" != "8" ]]; then
      echo "Sui is not the pending proposal (pending: $domain)." >&2
      exit 1
    fi
    echo "Committing Sui ($SEND_FLAG)"
    invoke "$SEND_FLAG" -- commit_domain
    ;;
  *)
    echo "usage: $0 status|commit-pending|propose-sui|commit-sui" >&2
    exit 2
    ;;
esac
