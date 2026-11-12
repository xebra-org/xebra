import { type TransferBuild, type Quote as XebraQuote, createXebraClient } from "@xebra/sdk";
import { parseUsdcAmount } from "@xebra/sdk/core";
import { createIntentsRouter, intentsAccountFor, usdcChainOf } from "@xebra/sdk/intents";
import * as oneclick from "./oneclick";

/**
 * Prices a swap that starts with USDC on Stellar and ends with any asset NEAR Intents can deliver,
 * two ways, and prepares the cheaper one for the user's wallet to sign.
 *
 * - **Direct:** the user deposits Stellar USDC into NEAR Intents (through the HOT bridge) and a
 *   solver swaps it. Only possible when some solver quotes Stellar USDC.
 * - **Through Xebra:** Xebra moves the USDC from Stellar to a chain where NEAR Intents' USDC is
 *   deepest (Base first) over Circle's CCTP, straight into a 1Click deposit address there, and a
 *   solver takes it from that deposit. One signature, on Stellar.
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

export interface PlanRequest {
  /** Decimal USDC on Stellar, e.g. "25". */
  amount: string;
  /** The user's Stellar account; it signs, and refunds go to its NEAR Intents account. */
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

/** About how long Xebra's leg takes from Stellar: Stellar finality, Circle's attestation, the mint. */
const XEBRA_LEG_SECONDS = 60;

async function findTokens(destinationAsset: string) {
  const list = await oneclick.tokens();
  const destination = list.find((t) => t.assetId === destinationAsset);
  if (!destination) throw new Error("NEAR Intents does not list that asset.");
  const stellarUsdc = list.find((t) => usdcChainOf(t) === "stellar");
  const usdcOn = (chain: string) => list.find((t) => usdcChainOf(t) === chain);
  return { destination, stellarUsdc, usdcOn };
}

function request(
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
    ...over,
    ...extra,
  };
}

function validate(r: PlanRequest) {
  if (parseUsdcAmount(r.amount) === null) throw new Error("Enter an amount of USDC, e.g. 25.");
  intentsAccountFor(r.sender); // throws on anything but a Stellar account
  if (!r.recipient.trim()) throw new Error("Enter who receives.");
}

/** Both prices, read-only. Nothing is reserved and no deposit address is issued. */
export async function compare(r: PlanRequest): Promise<Comparison> {
  validate(r);
  const { destination, stellarUsdc, usdcOn } = await findTokens(r.destinationAsset);

  const direct: Promise<PathPrice> = (async () => {
    if (!stellarUsdc)
      return { available: false, reason: "NEAR Intents does not list Stellar USDC." };
    try {
      const { quote } = await oneclick.quote(
        request(
          {
            dry: true,
            originAsset: stellarUsdc.assetId,
            amount: toUnits(r.amount, stellarUsdc.decimals),
            refundTo: r.sender,
            refundType: "ORIGIN_CHAIN",
          },
          r,
          { depositMode: "MEMO" },
        ),
      );
      return {
        available: true,
        amountOut: quote.amountOutFormatted,
        ...(quote.amountOutUsd ? { amountOutUsd: quote.amountOutUsd } : {}),
        timeEstimate: quote.timeEstimate,
      };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  })();

  const viaXebra: Promise<ViaXebraPrice> = (async () => {
    let hub: string | null;
    try {
      hub = await router.pickHub("stellar");
    } catch {
      return { available: false, reason: "Xebra could not be reached." };
    }
    if (!hub)
      return { available: false, reason: "Xebra reaches no NEAR Intents hub from Stellar." };
    const hubUsdc = usdcOn(hub);
    if (!hubUsdc) return { available: false, reason: `NEAR Intents does not list USDC on ${hub}.` };
    let xq: XebraQuote;
    try {
      xq = await xebra.quote({ from: "stellar", to: hub as XebraQuote["to"], amount: r.amount });
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
            refundTo: intentsAccountFor(r.sender),
            refundType: "INTENTS",
          },
          r,
        ),
      );
      return {
        available: true,
        hub,
        xebra: xq,
        amountOut: quote.amountOutFormatted,
        ...(quote.amountOutUsd ? { amountOutUsd: quote.amountOutUsd } : {}),
        timeEstimate: quote.timeEstimate + XEBRA_LEG_SECONDS,
      };
    } catch (err) {
      return {
        available: false,
        hub,
        xebra: xq,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  return { amount: r.amount, destination, direct: await direct, viaXebra: await viaXebra };
}

export interface Prepared {
  hub: string;
  depositAddress: string;
  intents: oneclick.Quote;
  xebra: XebraQuote;
  build: TransferBuild;
  refundAccount: string;
}

/**
 * A real 1Click quote (which issues a deposit address on the hub chain) and the Stellar
 * transaction that sends the user's USDC there through Xebra. Nothing is signed here.
 *
 * The 1Click quote is FLEX_INPUT so the deposit is accepted at whatever Xebra delivers, and its
 * refund goes to the user's own NEAR Intents account (their Stellar key), since they hold nothing
 * on the hub chain. `maxTotalFee` pins Xebra's leg to the fee just quoted.
 */
export async function prepare(r: PlanRequest): Promise<Prepared> {
  validate(r);
  const { usdcOn } = await findTokens(r.destinationAsset);
  const hub = await router.pickHub("stellar");
  if (!hub) throw new Error("Xebra reaches no NEAR Intents hub from Stellar right now.");
  const hubUsdc = usdcOn(hub);
  if (!hubUsdc) throw new Error(`NEAR Intents does not list USDC on ${hub}.`);

  const xq = await xebra.quote({ from: "stellar", to: hub as XebraQuote["to"], amount: r.amount });
  const refundAccount = intentsAccountFor(r.sender);
  const { quote } = await oneclick.quote(
    request(
      {
        dry: false,
        originAsset: hubUsdc.assetId,
        amount: toUnits(xq.recipientGets, hubUsdc.decimals),
        refundTo: refundAccount,
        refundType: "INTENTS",
      },
      r,
      { swapType: "FLEX_INPUT" },
    ),
  );
  if (!quote.depositAddress) throw new Error("NEAR Intents issued no deposit address.");

  const build = await router.buildDeposit({
    from: "stellar",
    depositChain: hub,
    depositAddress: quote.depositAddress,
    sender: r.sender,
    amount: r.amount,
    maxTotalFee: xq.fees.total,
  });
  return {
    hub,
    depositAddress: quote.depositAddress,
    intents: quote,
    xebra: xq,
    build,
    refundAccount,
  };
}

/** Where both legs are: Xebra's burn on Stellar, then NEAR Intents' swap at the deposit address. */
export async function track(depositAddress: string, stellarTx?: string) {
  const [xebraLeg, intentsLeg] = await Promise.all([
    stellarTx ? xebra.getTransfer("stellar", stellarTx).catch(() => null) : Promise.resolve(null),
    oneclick.status(depositAddress).catch(() => null),
  ]);
  return { xebra: xebraLeg, intents: intentsLeg };
}
