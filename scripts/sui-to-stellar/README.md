# Sui to Stellar (USDC, CCTP V2, mainnet)

Two standalone tools that move USDC from Sui to Stellar with no relayer service. They are not part of
the pnpm workspace; install with `npm ci` in this folder.

**Status:** the burn was simulated against mainnet on 2026-11-05 (succeeds; Stellar is a registered
remote TokenMessenger on Sui; emitted message is CCTP V2, source domain 8, destination domain 27).
A real transfer has not been run yet, so Circle's attestation of a Sui burn and the Stellar mint are
unverified. Start with 1 USDC.

## How it works

1. `burn.mts` calls Circle's Sui `deposit_for_burn` (the same call sequence as Circle's own
   `sui-cctp` `addDepositForBurnV2`) with destination domain 27, `mintRecipient` = Stellar's
   `CctpForwarder`, and the real recipient in the hook data (32-byte header + the G... address as
   text, the encoding `@asctp/parabola` uses). `destinationCaller` is the forwarder too, as Circle
   requires (zero would let anyone call `receive_message` directly and strand the USDC). Anyone can
   still finish it through `mint_and_forward`.
2. Circle's Iris service attests the burn.
3. `complete.mts` waits for the attestation and calls `mint_and_forward` on the forwarder from any
   funded XLM account. The recipient is fixed by the burn, so the fee payer cannot redirect funds.

The recipient must already exist on Stellar and hold a USDC trustline. `complete.mts` checks this and
refuses to spend otherwise; a mint to an account without a trustline cannot land and the USDC sits at
the forwarder.

## Run it

```bash
cd scripts/sui-to-stellar && npm ci

# 1. Dry run: simulate the burn as SENDER. Signs and sends nothing.
SENDER=0x<sui address holding USDC> STELLAR_RECIPIENT=G... AMOUNT=1000000 npx tsx burn.mts

# 2. Burn for someone else (their key never leaves their machine): print the unsigned transaction.
MODE=build SENDER=0x... STELLAR_RECIPIENT=G... AMOUNT=1000000 npx tsx burn.mts
#    They sign the base64 with their wallet, or: sui keytool sign --address <sender> --data <base64>
#    and submit: sui client execute-signed-tx --tx-bytes <base64> --signatures <sig>
#    Note the digest of the executed transaction.

# 3. Complete on Stellar. MODE=simulate stops after a successful simulation and sends nothing.
SUI_DIGEST=<digest> STELLAR_RECIPIENT=G... STELLAR_SECRET=S... npx tsx complete.mts
```

`AMOUNT` is in base units (USDC has 6 decimals; 1000000 = 1 USDC). `MODE=send` on `burn.mts` signs with
`SUI_SIGNER_KEY` and needs `CONFIRM_MAINNET=yes`; use it only for your own key. Never ask another person
to paste a private key into anything: use `MODE=build`.

## Addresses used (mainnet)

Sui CCTP V2 package and state IDs come from Circle's
[Sui packages](https://developers.circle.com/cctp/references/sui-packages) page and were checked on
chain. Stellar contracts are from `@asctp/parabola`'s `STELLAR_MAINNET`. Re-check both before moving
meaningful amounts.

## Known limits

- One chain pair, standard finality only (Stellar has no Fast Transfer).
- Confirmation goes through Horizon because stellar-sdk 13 cannot decode protocol 23+ result meta.
- Circle's docs still say Sui requires V1. The mainnet V2 contracts say otherwise, and the simulation
  succeeded; trust the chain over the prose, and trust a real attested transfer over both.
