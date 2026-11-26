import { type SuiBoundMessage, readSuiBoundMessage } from "@xebra/sdk/build";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { env } from "../env";
import { type RelayDeps, submitSuiMint } from "../stellar-sui/relayer";
import { readAttestation } from "../sui-stellar/attestation";
import type { CompleteResult } from "../sui-stellar/stellar-side";

/**
 * Xebra's Sui relayer for transfers that start on an EVM chain (Arc first): submits Circle's
 * attested mint on Sui and pays the gas from the same key as the Stellar to Sui relayer
 * (`SUI_RELAYER_SECRET`), so the recipient needs no SUI.
 *
 * Circle does not deliver to Sui. An EVM burn to Sui names the recipient's Sui address as
 * `mintRecipient`, carries no hook, and leaves `destinationCaller` zero, so this relayer or the
 * recipient (at `/claim`) can submit the mint. Anyone may call it for any burn, and that is safe by
 * construction:
 *  - The USDC goes to the burn's `mintRecipient`, signed by Circle. The relayer only pays gas.
 *  - Only burns from chains this deployment sends to Sui from (`NEXT_PUBLIC_EVM_TO_SUI`) are paid
 *    for, so with the switch off nothing is.
 *  - Only burns of at least 1 USDC, the same floor as the Stellar relayer: a mint costs about
 *    0.003 SUI, and a free relay for dust would be a way to drain the key. Xebra's flat fee is its
 *    own EVM transaction and is not checked here, as on the EVM to Stellar relayer.
 *  - Each message mints once (Circle's nonce), so a second call answers `delivered`, and the gas
 *    budget is simulated and capped before signing (`MAX_GAS_MIST`).
 */

/** The smallest burn the relayer pays the Sui gas for, 6 decimals. */
export const SUI_INBOUND_MIN_UNITS = 1_000_000n;

/** The CCTP domains of the EVM chains whose burns into Sui this deployment relays. */
export function suiInboundSources(): readonly number[] {
  return (env.evmRoutes.evmToSui ?? []).map((id) => EVM_CHAINS[id].cctpDomainId);
}

/**
 * Why we will not pay for this burn, or null when we will. Pure, so each refusal is tested without
 * a node: the message must be a burn to Sui from the chain asked about, open to any caller, and at
 * least the floor.
 */
export function inboundProblem(
  message: SuiBoundMessage,
  src: number,
  minUnits: bigint = SUI_INBOUND_MIN_UNITS,
): string | null {
  if (message.sourceDomain !== src) {
    return "Circle's message was burned on a different chain than the one asked about.";
  }
  if (message.destinationCaller !== null) {
    return `This transfer names ${message.destinationCaller} as the only wallet that may mint it, so Xebra cannot.`;
  }
  if (message.amount < minUnits) {
    return `Xebra pays the Sui fee for transfers of at least ${Number(minUnits) / 1e6} USDC. Smaller ones can be claimed with any Sui wallet at /claim.`;
  }
  return null;
}

export interface InboundRelayDeps extends Omit<RelayDeps, "wrapperBurnIn"> {
  /** The source domains relayed. Default `suiInboundSources()`. */
  sources?: readonly number[];
}

// One instance never sends the same burn twice at once; see `relayStellarToSui`.
const inFlight = new Set<string>();

/**
 * Finishes one EVM to Sui transfer. Every refusal happens before any gas is spent: the mint is
 * simulated while it is built, and a burn already minted answers `delivered`.
 */
export async function relayEvmToSui(
  tx: string,
  src: number,
  deps: InboundRelayDeps,
): Promise<CompleteResult> {
  const sources = deps.sources ?? suiInboundSources();
  if (!sources.includes(src)) {
    return {
      status: "refused",
      reason: "Xebra does not relay transfers into Sui from that chain here.",
    };
  }
  const key = `${src}:${tx.toLowerCase()}`;
  if (inFlight.has(key)) return { status: "pending", reason: "already being completed" };
  inFlight.add(key);
  try {
    const att = await (deps.readAttestation ?? readAttestation)(tx, src);
    if (att.state !== "complete") {
      return att.state === "pending"
        ? { status: "pending" }
        : { status: "unknown", reason: att.reason };
    }

    let message: SuiBoundMessage;
    try {
      message = readSuiBoundMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"));
    } catch (err) {
      return {
        status: "refused",
        reason: err instanceof Error ? err.message : "not a transfer to Sui",
      };
    }
    const problem = inboundProblem(message, src);
    if (problem) return { status: "refused", reason: problem };

    return await submitSuiMint(att, deps, "evm-sui");
  } finally {
    inFlight.delete(key);
  }
}
