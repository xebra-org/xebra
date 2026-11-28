import { type TransferBuild, type Quote as XebraQuote, createXebraClient } from "@xebra/sdk";
import { EVM_CHAINS, checkAddressOn, isEvmChainId, parseUsdcAmount } from "@xebra/sdk/core";
import {
  createIntentsRouter,
  intentsAccountFor,
  toXebraChain,
  usdcChainOf,
} from "@xebra/sdk/intents";
import { PlanInputError } from "./errors";
import * as oneclick from "./oneclick";
import { RECIPIENT_RULES, recipientProblem } from "./recipients";
import { type XrpAccount, xrpAccount, xrpDeliveryProblem } from "./xrpl";

export { PlanInputError };

/**
 * Prices a swap that starts with USDC on a CCTP chain (Stellar, Arc, or any EVM chain Xebra sends
 * from) and ends with any asset NEAR Intents can deliver, two ways, and prepares the cheaper one
 * for the user's wallet to sign.
 *
 * - **Direct:** the user deposits their chain's USDC into NEAR Intents and a solver swaps it. Only
 *   possible when Intents lists that chain's USDC and some solver quotes it. It does not for
 *   Stellar, Arc, Unichain, Sonic, World Chain, Sei, XDC, Ink, Codex and others.
 * - **Through Xebra:** Xebra moves the USDC from the user's chain to a chain where NEAR Intents'
 *   USDC is deepest (Base first) over Circle's CCTP, straight into a 1Click deposit address there,
 *   and a solver takes it from that deposit. The user signs on their own chain only.
 *
 * The Xebra leg is chosen with `@xebra/sdk/intents`, the same calls the integration guide gives
 * NEAR Intents: ask `isRouteAvailable` first, keep the usual path when the answer is no.
 */

const XEBRA_API = process.env.XEBRA_API_URL?.trim() || "https://api.xebra.exchange";
const xebra = createXebraClient({ baseUrl: XEBRA_API });
const router = createIntentsRouter({ client: xebra });

/** 1% either way: the deposit is the exact amount Xebra delivers, so the band only covers price. */
const SLIPPAGE_BPS = 100;
const DEADLINE_MS = 60 * 60_000;

/**
 * Tags every 1Click quote Xebra asks for, so NEAR Intents' records show which swaps came in
 * through Xebra. Lower case, as 1Click requires.
 */
export const ONECLICK_REFERRAL = "xebra";

export interface PlanRequest {
  /**
   * The chain the user's USDC is on, named as Xebra or NEAR Intents names it. Default `stellar`.
   */
  from?: string;
  /** Decimal USDC on the source chain, e.g. "25". */
  amount: string;
  /**
   * The user's address on the source chain; it signs. A Stellar sender's refunds go to its own
   * NEAR Intents account; an EVM sender's go to the same address on the hub chain.
   */
  sender: string;
  /** A 1Click asset id, e.g. `nep141:wrap.near`. */
  destinationAsset: string;
  /** Who receives, on the destination asset's chain. */
  recipient: string;
}

export interface PathPrice {
  available: boolean;
  /** Why not, in a sentence, when unavailable. */
  reason?: string;
  amountOut?: string;
  amountOutUsd?: string;
  /** Seconds, NEAR Intents' estimate plus Xebra's leg where there is one. */
  timeEstimate?: number;
}

export interface ViaXebraPrice extends PathPrice {
  hub?: string;
  xebra?: XebraQuote;
}

export interface Comparison {
  from: string;
  amount: string;
  destination: oneclick.OneClickToken;
  direct: PathPrice;
  viaXebra: ViaXebraPrice;
}

/** Decimal to base units for a token with `decimals` places. */
export function toUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not an amount: ${amount}`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return (BigInt(m[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}

/** The chains a swap can start on: Stellar and the EVM chains (Arc included). */
type Source = "stellar" | keyof typeof EVM_CHAINS;

/**
 * About how long Xebra's leg takes: source finality, Circle's attestation, the mint. Stellar and
 * the fast-finality chains settle in under a minute; the rollups wait for Ethereum's finality.
 */
export function legSeconds(from: Source): number {
  if (from === "stellar") return 60;
  const eta = EVM_CHAINS[from].standardEta;
  if (/under a minute/.test(eta)) return 60;
  const minutes = [...eta.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return minutes.length ? Math.max(...minutes) * 60 : 20 * 60;
}

/** The source chain of a request, or a sentence saying why it is not one. */
export function sourceOf(r: Pick<PlanRequest, "from">): Source {
  const chain = toXebraChain(r.from ?? "stellar");
  if (chain === "stellar" || (chain && isEvmChainId(chain))) return chain as Source;
  throw new PlanInputError(`Swaps through Xebra start on Stellar or an EVM chain, not ${r.from}.`);
}

/**
 * Where NEAR Intents sends a refund if the swap cannot be filled, and on which ledger.
 * A Stellar wallet owns a NEAR Intents account already (its key, SEP-53), so the refund waits
 * there. An EVM wallet is the same address on every EVM chain, so the refund goes to it on the hub.
 */
export function refundFor(from: Source, sender: string) {
  return from === "stellar"
    ? { refundTo: intentsAccountFor(sender), refundType: "INTENTS" as const }
    : { refundTo: sender, refundType: "ORIGIN_CHAIN" as const };
}

async function findTokens(destinationAsset: string, from: Source) {
  const list = await oneclick.tokens();
  const destination = list.find((t) => t.assetId === destinationAsset);
  if (!destination) throw new PlanInputError("NEAR Intents does not list that asset.");
  const usdcOn = (chain: string) => list.find((t) => usdcChainOf(t) === chain);
  return { destination, sourceUsdc: usdcOn(from), usdcOn };
}

function chainName(from: Source): string {
  return from === "stellar" ? "Stellar" : EVM_CHAINS[from].name;
}

export function request(
  over: Pick<oneclick.QuoteRequest, "dry" | "originAsset" | "amount" | "refundTo" | "refundType">,
  r: PlanRequest,
  extra: Partial<oneclick.QuoteRequest> = {},
): oneclick.QuoteRequest {
  return {
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: r.destinationAsset,
    recipient: r.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
    referral: ONECLICK_REFERRAL,
    ...over,
    ...extra,
  };
}

function validate(r: PlanRequest): Source {
  const from = sourceOf(r);
  if (parseUsdcAmount(r.amount) === null) {
    throw new PlanInputError("Enter an amount of USDC, e.g. 25.");
  }
  if (from === "stellar") {
    try {
      intentsAccountFor(r.sender);
    } catch {
      throw new PlanInputError("The sender must be a Stellar account address (it starts with G).");
    }
  } else {
    const check = checkAddressOn(EVM_CHAINS[from], r.sender);
    if (!check.ok) {
      throw new PlanInputError(check.error ?? `Not an address on ${chainName(from)}.`);
    }
  }
  if (!r.recipient.trim()) throw new PlanInputError("Enter who receives.");
  return from;
}

/**
 * Refuses a recipient that cannot receive `destination`, before anything is quoted: its format and
 * checksum on that chain, and for XRP what the ledger says about the account. Returns the XRP
 * account, whose reserve is checked again once the amount is known.
 */
async function checkRecipient(
  destination: oneclick.OneClickToken,
  recipient: string,
): Promise<XrpAccount | null> {
  const problem = recipientProblem(destination.blockchain, recipient);
  if (problem) throw new PlanInputError(problem);
  if (destination.blockchain !== "xrp") return null;
  let account: XrpAccount;
  try {
    account = await xrpAccount(recipient.trim());
  } catch (err) {
    throw new PlanInputError(err instanceof Error ? err.message : String(err), 503);
  }
  const refused = xrpDeliveryProblem(account);
  if (refused) throw new PlanInputError(refused);
  return account;
}

/**
 * 1Click's answer in words a person can act on. Its "recipient is not valid" becomes the chain's
 * own sentence, and a bridge minimum given in base units of `originDecimals` becomes USDC.
 */
export function explainQuoteError(
  err: unknown,
  blockchain: string,
  originDecimals: number,
): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/recipient is not valid/i.test(message)) {
    return Object.hasOwn(RECIPIENT_RULES, blockchain)
      ? (RECIPIENT_RULES[blockchain]?.invalid ?? message)
      : message;
  }
  const min = /amount is too low for bridge, try at least (\d+)/i.exec(message);
  if (min?.[1]) {
    return `NEAR Intents needs at least ${fromUnits(min[1], originDecimals)} USDC for this destination. Send more.`;
  }
  return message;
}

/** Base units to a decimal string, trailing zeros dropped. */
function fromUnits(units: string, decimals: number): string {
  const s = units.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Both prices, read-only. Nothing is reserved and no deposit address is issued. */
export async function compare(r: PlanRequest): Promise<Comparison> {
  const from = validate(r);
  const { destination, sourceUsdc, usdcOn } = await findTokens(r.destinationAsset, from);
  const xrp = await checkRecipient(destination, r.recipient);

  const direct: Promise<PathPrice> = (async () => {
    if (!sourceUsdc)
      return {
        available: false,
        reason: `NEAR Intents does not list ${chainName(from)} USDC.`,
      };
    try {
      const { quote } = await oneclick.quote(
        request(
          {
            dry: true,
            originAsset: sourceUsdc.assetId,
            amount: toUnits(r.amount, sourceUsdc.decimals),
            refundTo: r.sender,
            refundType: "ORIGIN_CHAIN",
          },
          r,
          from === "stellar" ? { depositMode: "MEMO" } : {},
        ),
      );
      const refused = xrp && xrpDeliveryProblem(xrp, quote.minAmountOut);
      if (refused) return { available: false, reason: refused };
      return {
        available: true,
        amountOut: quote.amountOutFormatted,
        ...(quote.amountOutUsd ? { amountOutUsd: quote.amountOutUsd } : {}),
        timeEstimate: quote.timeEstimate,
      };
    } catch (err) {
      return {
        available: false,
        reason: explainQuoteError(err, destination.blockchain, sourceUsdc.decimals),
      };
    }
  })();

  const viaXebra: Promise<ViaXebraPrice> = (async () => {
    let hub: string | null;
    try {
      hub = await router.pickHub(from);
    } catch {
      return { available: false, reason: "Xebra could not be reached." };
    }
    if (!hub)
      return {
        available: false,
        reason: `Xebra reaches no NEAR Intents hub from ${chainName(from)}.`,
      };
    const hubUsdc = usdcOn(hub);
    if (!hubUsdc) return { available: false, reason: `NEAR Intents does not list USDC on ${hub}.` };
    let xq: XebraQuote;
    try {
      xq = await xebra.quote({
        from: from as XebraQuote["from"],
        to: hub as XebraQuote["to"],
        amount: r.amount,
      });
    } catch (err) {
      return { available: false, hub, reason: err instanceof Error ? err.message : String(err) };
    }
    try {
      const { quote } = await oneclick.quote(
        request(
          {
            dry: true,
            originAsset: hubUsdc.assetId,
            amount: toUnits(xq.recipientGets, hubUsdc.decimals),
            ...refundFor(from, r.sender),
          },
          r,
        ),
      );
      const refused = xrp && xrpDeliveryProblem(xrp, quote.minAmountOut);
      if (refused) return { available: false, hub, xebra: xq, reason: refused };
      return {
        available: true,
        hub,
        xebra: xq,
        amountOut: quote.amountOutFormatted,
        ...(quote.amountOutUsd ? { amountOutUsd: quote.amountOutUsd } : {}),
        timeEstimate: quote.timeEstimate + legSeconds(from),
      };
    } catch (err) {
      return {
        available: false,
        hub,
        xebra: xq,
        reason: explainQuoteError(err, destination.blockchain, hubUsdc.decimals),
      };
    }
  })();

  return {
    from,
    amount: r.amount,
    destination,
    direct: await direct,
    viaXebra: await viaXebra,
  };
}

export interface Prepared {
  from: string;
  hub: string;
  depositAddress: string;
  intents: oneclick.Quote;
  xebra: XebraQuote;
  build: TransferBuild;
  refundAccount: string;
}

/**
 * A real 1Click quote (which issues a deposit address on the hub chain) and the transaction(s)
 * that send the user's USDC there through Xebra, from their own chain. Nothing is signed here.
 *
 * The 1Click quote is FLEX_INPUT so the deposit is accepted at whatever Xebra delivers. A refund
 * goes where `refundFor` says: a Stellar user's own NEAR Intents account, or an EVM user's own
 * address on the hub. `maxTotalFee` pins Xebra's leg to the fee just quoted.
 */
export async function prepare(r: PlanRequest): Promise<Prepared> {
  const from = validate(r);
  const { destination, usdcOn } = await findTokens(r.destinationAsset, from);
  const xrp = await checkRecipient(destination, r.recipient);
  const hub = await router.pickHub(from);
  if (!hub) throw new Error(`Xebra reaches no NEAR Intents hub from ${chainName(from)} right now.`);
  const hubUsdc = usdcOn(hub);
  if (!hubUsdc) throw new Error(`NEAR Intents does not list USDC on ${hub}.`);

  const xq = await xebra.quote({
    from: from as XebraQuote["from"],
    to: hub as XebraQuote["to"],
    amount: r.amount,
  });
  const refund = refundFor(from, r.sender);
  let quote: oneclick.Quote;
  try {
    ({ quote } = await oneclick.quote(
      request(
        {
          dry: false,
          originAsset: hubUsdc.assetId,
          amount: toUnits(xq.recipientGets, hubUsdc.decimals),
          ...refund,
        },
        r,
        { swapType: "FLEX_INPUT" },
      ),
    ));
  } catch (err) {
    if (!(err instanceof oneclick.OneClickError)) throw err;
    throw new oneclick.OneClickError(
      explainQuoteError(err, destination.blockchain, hubUsdc.decimals),
      err.status,
    );
  }
  if (!quote.depositAddress) throw new Error("NEAR Intents issued no deposit address.");
  // The deposit address is issued but nothing has moved: refusing here costs the user nothing.
  const refused = xrp && xrpDeliveryProblem(xrp, quote.minAmountOut);
  if (refused) throw new PlanInputError(refused);

  const build = await router.buildDeposit({
    from,
    depositChain: hub,
    depositAddress: quote.depositAddress,
    sender: r.sender,
    amount: r.amount,
    maxTotalFee: xq.fees.total,
  });
  return {
    from,
    hub,
    depositAddress: quote.depositAddress,
    intents: quote,
    xebra: xq,
    build,
    refundAccount: refund.refundTo,
  };
}

/**
 * Where both legs are: Xebra's burn on the source chain, then NEAR Intents' swap at the deposit
 * address.
 */
export async function track(depositAddress: string, sourceTx?: string, from = "stellar") {
  const chain = sourceOf({ from });
  const [xebraLeg, intentsLeg] = await Promise.all([
    sourceTx ? xebra.getTransfer(chain, sourceTx).catch(() => null) : Promise.resolve(null),
    oneclick.status(depositAddress).catch(() => null),
  ]);
  return { xebra: xebraLeg, intents: intentsLeg };
}
