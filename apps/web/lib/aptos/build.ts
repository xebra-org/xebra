import { StrKey } from "@stellar/stellar-sdk";
import type { CircleHealth } from "@xebra/cctp-client";
import {
  APTOS_BURN_SCRIPT,
  APTOS_CHAIN_ID,
  APTOS_DOMAIN,
  type AptosBurnArgs,
  type AptosBurnArgsJson,
  type AptosTxEnvelope,
  type BurnRecipient,
  aptosBurnArgs,
  aptosBurnArgsToJson,
  normaliseAptosAddress,
} from "@xebra/sdk/build";
import {
  EVM_CHAINS,
  bytesToHex,
  checkAddressOn,
  checkSolanaAddress,
  formatUsdc6,
  parseMessage,
  parseUsdcAmount,
  planEvmFee,
  solanaAddressToBytes32,
  stellarBurnRecipient,
  verifyMessage,
} from "@xebra/sdk/core";
import { feeDestination, routeDestination } from "../route-destination";
import { type AptosDestination, aptosDestinationDomain, isAptosDestination } from "./config";
import { type SimulationResult, describeVmStatus, maxGasFor } from "./node";

/**
 * Builds a burn on Aptos for the connected wallet to sign. Nothing is signed or sent here.
 *
 * To an EVM chain, Arc or Solana, Circle's Forwarding Service delivers the mint: the fee is priced
 * here from a fresh quote with the same rules as every direct EVM route (`planEvmFee`), and if it
 * has risen above the `maxFee` the page showed, the burn is refused (409) rather than signed at a
 * fee nobody saw. To Stellar nothing forwards and Circle is paid nothing; the relayer or the sender
 * completes it. No Xebra fee on any of these routes yet.
 *
 * Every check that can be made before signing is made here, cheapest first: the request, the
 * recipient (a Solana wallet becomes its USDC token account, read on the server; a Stellar account
 * must exist with a trustline), the price, the sender's account and USDC, and finally a simulation
 * of the burn against mainnet, whose emitted CCTP message is read back and compared with what was
 * asked for. A burn that would strand USDC is never handed to a wallet.
 */

export interface AptosBuildDeps {
  destinations(): AptosDestination[];
  maxUnits(): bigint | null;
  /** Circle's health and quote for Aptos to this domain (`checkCircle`). */
  circle(dst: number, newAccount: boolean, maxFeeUnits: number): Promise<CircleHealth>;
  /** A Solana wallet's USDC token account and whether it exists, as `/api/recipient` answers. */
  solanaAccount(owner: string): Promise<{ tokenAccount: string; status: string }>;
  stellarAccount(address: string): Promise<{ exists: boolean; hasTrustline: boolean }>;
  /** Null when the account does not exist on Aptos. */
  sequenceNumber(owner: string): Promise<bigint | null>;
  usdcBalance(owner: string): Promise<bigint>;
  envelope(sender: `0x${string}`, sequenceNumber: bigint): Promise<AptosTxEnvelope>;
  simulate(args: AptosBurnArgs, envelope: AptosTxEnvelope): Promise<SimulationResult>;
  /** Stellar's token messenger, for checking a simulated message to Stellar. */
  stellarTokenMessenger: string;
}

export interface AptosBuildRequest {
  sender?: unknown;
  amount?: unknown;
  to?: unknown;
  recipient?: unknown;
  /** What the page showed Circle being paid, in 6-decimal units. Not used for Stellar. */
  maxFee?: unknown;
}

export interface AptosBuildAnswer {
  status: number;
  body:
    | { error: string; maxFee?: string }
    | {
        transaction: {
          kind: "aptos";
          chainId: number;
          bytecode: `0x${string}`;
          arguments: AptosBurnArgsJson;
        };
        envelope: {
          sequenceNumber: string;
          maxGasAmount: string;
          gasUnitPrice: string;
          expirationTimestampSecs: string;
        };
        maxFee: string;
        received: string;
        /** Solana only: the token account the burn mints into. */
        tokenAccount?: string;
        opensAccount?: boolean;
      };
}

const no = (status: number, error: string, extra: { maxFee?: string } = {}): AptosBuildAnswer => ({
  status,
  body: { error, ...extra },
});

const NAMES = (d: AptosDestination) =>
  d === "solana" ? "Solana" : d === "stellar" ? "Stellar" : EVM_CHAINS[d].name;

export async function buildAptosTransfer(
  req: AptosBuildRequest,
  deps: AptosBuildDeps,
): Promise<AptosBuildAnswer> {
  const to = req.to;
  if (!isAptosDestination(to) || !deps.destinations().includes(to)) {
    return no(400, "Aptos does not send to that chain here.");
  }
  const name = NAMES(to);
  const sender = typeof req.sender === "string" ? normaliseAptosAddress(req.sender) : null;
  if (!sender) return no(400, "That is not an Aptos address.");
  const amount = typeof req.amount === "string" ? parseUsdcAmount(req.amount) : null;
  if (amount === null || amount <= 0n) {
    return no(400, "Enter an amount of USDC, up to 6 decimals.");
  }
  const cap = deps.maxUnits();
  if (cap !== null && amount > cap) {
    return no(422, `The limit is ${formatUsdc6(cap)} USDC per transfer.`);
  }
  const recipientIn = typeof req.recipient === "string" ? req.recipient.trim() : "";

  // The recipient, as the destination needs it.
  let recipient: BurnRecipient;
  let opensAccount = false;
  let tokenAccount: string | undefined;
  if (to === "stellar") {
    // G... accounts only: a contract has no trustline to check, so a mint to one cannot be
    // checked before it is burned.
    if (!StrKey.isValidEd25519PublicKey(recipientIn)) {
      return no(400, "The recipient must be a Stellar account address starting with G.");
    }
    const account = await deps.stellarAccount(recipientIn);
    if (!account.exists) {
      return no(
        422,
        "That Stellar account does not exist yet. It needs XLM to be created and a USDC trustline before it can receive.",
      );
    }
    if (!account.hasTrustline) {
      return no(422, "That Stellar account has no USDC trustline. Add one, then try again.");
    }
    recipient = stellarBurnRecipient(recipientIn);
  } else if (to === "solana") {
    const owner = checkSolanaAddress(recipientIn);
    if (!owner.ok || !owner.bytes) {
      return no(400, owner.error ?? "That is not a Solana address.");
    }
    const found = await deps.solanaAccount(recipientIn);
    if (found.status !== "exists" && found.status !== "missing") {
      // The price depends on whether Circle must open the account, so an unknown is not guessed.
      return no(
        503,
        "Whether the recipient has a USDC account on Solana could not be read just now. Nothing was burned; try again shortly.",
      );
    }
    opensAccount = found.status === "missing";
    tokenAccount = found.tokenAccount;
    const ata = bytesToHex(solanaAddressToBytes32(found.tokenAccount));
    recipient = {
      kind: "solana",
      tokenAccount: ata,
      createAccountFor: opensAccount ? bytesToHex(owner.bytes) : undefined,
    };
  } else {
    const chain = EVM_CHAINS[to];
    const check = checkAddressOn(chain, recipientIn);
    if (!check.ok) return no(400, check.error ?? `That is not a ${chain.name} address.`);
    recipient = recipientIn;
  }

  // What Circle is paid: its delivery quote, or nothing to Stellar.
  let maxFee = 0n;
  let received = amount;
  if (to !== "stellar") {
    const shown =
      typeof req.maxFee === "string" && /^\d{1,12}$/.test(req.maxFee) ? BigInt(req.maxFee) : null;
    if (shown === null) return no(400, "The fee shown was not sent. Reload the page.");
    const dest = feeDestination(routeDestination(to), opensAccount);
    const health = await deps.circle(
      aptosDestinationDomain(to),
      opensAccount,
      dest.maxForwardFeeUnits,
    );
    const tier = health.tiers.standard;
    if (health.status === "down" || !tier) {
      return no(
        503,
        `Circle cannot deliver to ${name} right now${health.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing was burned; try again shortly.`,
      );
    }
    const plan = planEvmFee({ amount, tier, destination: dest });
    if (!plan.ok) return no(422, plan.reason);
    if (plan.maxFee > shown) {
      return no(
        409,
        `Circle's fee went up to ${formatUsdc6(plan.maxFee)} USDC since it was shown${opensAccount ? ", including opening the recipient's USDC account" : ""}. Check the new amount, then send again.`,
        { maxFee: plan.maxFee.toString() },
      );
    }
    maxFee = plan.maxFee;
    received = plan.received;
  }

  let args: AptosBurnArgs;
  try {
    args = aptosBurnArgs({
      amount,
      destinationDomain: aptosDestinationDomain(to),
      recipient,
      maxFee,
    });
  } catch (err) {
    return no(400, err instanceof Error ? err.message : "That transfer cannot be built.");
  }

  // The sender's side: an account that exists (it pays gas in APT), and enough USDC.
  const sequenceNumber = await deps.sequenceNumber(sender);
  if (sequenceNumber === null) {
    return no(
      422,
      "That Aptos account does not exist on chain yet, so it holds no USDC and no APT for the network fee.",
    );
  }
  const balance = await deps.usdcBalance(sender);
  if (balance < amount) {
    return no(
      422,
      `That Aptos address holds ${formatUsdc6(balance)} USDC, less than ${formatUsdc6(amount)}.`,
    );
  }

  // Run it against mainnet as it is now. A burn Aptos would abort costs gas for nothing; and the
  // message the burn would emit is the one Circle attests, so it is checked against the request.
  let envelope = await deps.envelope(sender, sequenceNumber);
  let sim: SimulationResult | null = null;
  try {
    sim = await deps.simulate(args, envelope);
  } catch (err) {
    // The node not answering says nothing about the burn. The wallet simulates again before it
    // asks for a signature, so this is a lost early warning, not a lost check.
    console.error("aptos simulation unavailable", err);
  }
  if (sim && !sim.ok) {
    return no(
      422,
      `${capitalise(describeVmStatus(sim.vmStatus))}. Nothing was burned. (${sim.vmStatus.slice(0, 160)})`,
    );
  }
  if (sim?.ok) {
    if (!sim.message) {
      console.error("aptos simulation emitted no CCTP message");
      return no(502, "Could not prepare the transfer. Try again in a moment.");
    }
    const mismatch = checkSimulatedMessage(sim.message, args, to, deps.stellarTokenMessenger);
    if (mismatch) {
      console.error("aptos simulated message does not match the request", mismatch);
      return no(500, "The transfer did not check out, so it was not prepared. Nothing was burned.");
    }
    envelope = { ...envelope, maxGasAmount: maxGasFor(sim.gasUsed) };
  }

  return {
    status: 200,
    body: {
      transaction: {
        kind: "aptos",
        chainId: APTOS_CHAIN_ID,
        bytecode: APTOS_BURN_SCRIPT,
        arguments: aptosBurnArgsToJson(args),
      },
      envelope: {
        sequenceNumber: envelope.sequenceNumber.toString(),
        maxGasAmount: envelope.maxGasAmount.toString(),
        gasUnitPrice: envelope.gasUnitPrice.toString(),
        expirationTimestampSecs: envelope.expirationTimestampSecs.toString(),
      },
      maxFee: maxFee.toString(),
      received: received.toString(),
      ...(tokenAccount ? { tokenAccount, opensAccount } : {}),
    },
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Whether the message a simulated burn emitted says what the request asked: from Aptos, to the
 * domain asked, the amount, the recipient, the caller and the hook. To Stellar it must also pass
 * the relayer's own checks. Returns what differs, or null.
 */
export function checkSimulatedMessage(
  messageHex: `0x${string}`,
  args: AptosBurnArgs,
  to: AptosDestination,
  stellarTokenMessenger: string,
): string | null {
  let m: ReturnType<typeof parseMessage>;
  try {
    m = parseMessage(Buffer.from(messageHex.slice(2), "hex"));
  } catch (err) {
    return err instanceof Error ? err.message : "unreadable message";
  }
  const hex = (b: Buffer) => `0x${b.toString("hex")}`;
  if (m.sourceDomain !== APTOS_DOMAIN) return "source domain";
  if (m.destinationDomain !== args.destinationDomain) return "destination domain";
  if (m.amount !== args.amount) return "amount";
  if (hex(m.mintRecipient) !== args.mintRecipient) return "mint recipient";
  if (hex(m.destinationCaller) !== args.destinationCaller) return "destination caller";
  if (hex(m.hookData) !== args.hookData) return "hook";
  if (to === "stellar") {
    try {
      verifyMessage(Buffer.from(messageHex.slice(2), "hex"), {
        tokenMessenger: stellarTokenMessenger,
        sources: [APTOS_DOMAIN],
      });
    } catch (err) {
      return err instanceof Error ? err.message : "not a burn the relayer would complete";
    }
  }
  return null;
}
