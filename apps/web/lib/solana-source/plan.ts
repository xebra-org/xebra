import { StrKey } from "@stellar/stellar-sdk";
import { FORWARD_HOOK, addressToBytes32 } from "@xebra/cctp-evm";
import type { DepositForBurnWithHookParams } from "@xebra/cctp-solana";
import {
  type EvmChain,
  STELLAR_CCTP_FORWARDER,
  checkAddressOn,
  stellarForwardHook,
} from "@xebra/sdk/core";
import { STELLAR_CCTP_DOMAIN } from "./config";

/**
 * What a Solana burn says, by destination. Pure, and the one place these bytes are decided: the
 * build route, the /v1 API and the tests all go through `solanaBurnParams`.
 *
 * # To an EVM chain (Arc included)
 *
 * Circle's Forwarding Service delivers the mint: `mintRecipient` is the recipient's address as 32
 * bytes, `destinationCaller` is zero (Circle's forwarder requires it, and it keeps a failed delivery
 * claimable by anyone), the hook is Circle's `cctp-forward` request, and `maxFee` pays Circle for the
 * delivery. The same burn as Sui to Monad and the EVM routes.
 *
 * # To Stellar
 *
 * Nothing forwards into Stellar, and a Stellar account cannot be a CCTP mint recipient. So
 * `mintRecipient` is Circle's `CctpForwarder` contract, `destinationCaller` is that same forwarder
 * (with zero, anyone could call `receive_message` directly, mint into the forwarder without paying
 * the recipient, and the USDC would be stuck there for good), and the hook names the Stellar
 * account the forwarder pays. `maxFee` is zero: Circle charges nothing for Standard, and nothing is
 * forwarded. Our relayer, or the owner, then calls `mint_and_forward`. Byte for byte what two real
 * mainnet Solana to Stellar burns carried (see `plan.test.ts`).
 */

/** Standard finality on every route from Solana: Circle charges nothing for it. */
export const SOLANA_STANDARD_FINALITY = 2000;

export type SolanaBurnTarget =
  | { kind: "evm"; chain: EvmChain; recipient: string }
  | { kind: "stellar"; recipient: string };

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

/** The forwarder's contract id as the 32 bytes a CCTP message carries. */
export function stellarForwarderBytes(forwarder: string = STELLAR_CCTP_FORWARDER): Uint8Array {
  return Uint8Array.from(StrKey.decodeContract(forwarder));
}

/**
 * The burn's parameters. Throws on a recipient that is not valid for the destination, on a Stellar
 * recipient that is not a G... account, and on an EVM burn without a delivery fee (Circle would not
 * forward it, and the USDC would wait for a claim).
 */
export function solanaBurnParams(
  target: SolanaBurnTarget,
  amount: bigint,
  maxFee: bigint,
): DepositForBurnWithHookParams {
  if (target.kind === "stellar") {
    // G... accounts only, as on the Sui pilot: a contract recipient has no trustline to check first.
    if (!StrKey.isValidEd25519PublicKey(target.recipient)) {
      throw new Error("The Stellar recipient must be an account address starting with G.");
    }
    if (maxFee !== 0n) throw new Error("A burn to Stellar carries no fee.");
    const forwarder = stellarForwarderBytes();
    return {
      amount,
      destinationDomain: STELLAR_CCTP_DOMAIN,
      mintRecipient: forwarder,
      destinationCaller: forwarder,
      maxFee: 0n,
      minFinalityThreshold: SOLANA_STANDARD_FINALITY,
      hookData: stellarForwardHook(target.recipient),
    };
  }
  const address = checkAddressOn(target.chain, target.recipient);
  if (!address.ok) throw new Error(address.error ?? `That is not a ${target.chain.name} address.`);
  if (maxFee <= 0n || maxFee >= amount) {
    throw new Error("maxFee must be above zero and below the amount");
  }
  return {
    amount,
    destinationDomain: target.chain.cctpDomainId,
    mintRecipient: hexBytes(addressToBytes32(target.recipient)),
    destinationCaller: new Uint8Array(32),
    maxFee,
    minFinalityThreshold: SOLANA_STANDARD_FINALITY,
    hookData: hexBytes(FORWARD_HOOK),
  };
}
