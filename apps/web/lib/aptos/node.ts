import {
  APTOS_CCTP,
  APTOS_CHAIN_ID,
  type AptosBurnArgs,
  type AptosTxEnvelope,
  aptosSimulationBytes,
} from "@xebra/sdk/build";
import { aptosApiKey, aptosRpcUrl } from "./config";

/**
 * What the server reads from an Aptos fullnode before it hands a burn to a wallet: the sender's
 * USDC, its sequence number and a gas price, and a simulation of the burn itself. Read-only: a
 * simulation carries no signature and cannot be submitted.
 */

const TIMEOUT_MS = 8_000;
/** What the simulation may report using, with headroom; the wallet sets its own if it prefers. */
const GAS_HEADROOM = 2n;
const MIN_MAX_GAS = 2_000n;
/** How long the wallet has to sign before the transaction expires. */
const EXPIRY_SECS = 600;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = aptosApiKey();
  return { ...extra, ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${aptosRpcUrl()}${path}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** USDC held in the owner's primary store, 6-decimal units. Zero for an account that has none. */
export async function aptosUsdcBalance(owner: string): Promise<bigint> {
  const res = await fetch(`${aptosRpcUrl()}/view`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      function: "0x1::primary_fungible_store::balance",
      type_arguments: ["0x1::fungible_asset::Metadata"],
      arguments: [owner, APTOS_CCTP.usdc],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the Aptos node answered ${res.status}`);
  const body = (await res.json()) as unknown;
  const v = Array.isArray(body) ? body[0] : null;
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("unexpected balance answer");
  return BigInt(v);
}

/** The account's next sequence number, or null when the account does not exist on chain. */
export async function aptosSequenceNumber(owner: string): Promise<bigint | null> {
  const { status, body } = await getJson<{ sequence_number?: string; error_code?: string }>(
    `/accounts/${owner}`,
  );
  if (status === 404) return null;
  if (status !== 200 || typeof body?.sequence_number !== "string") {
    throw new Error(`the Aptos node answered ${status}`);
  }
  return BigInt(body.sequence_number);
}

export async function aptosGasPrice(): Promise<bigint> {
  const { status, body } = await getJson<{ gas_estimate?: number }>("/estimate_gas_price");
  if (status !== 200 || typeof body?.gas_estimate !== "number") {
    throw new Error(`the Aptos node answered ${status}`);
  }
  return BigInt(body.gas_estimate);
}

export type SimulationResult =
  | { ok: true; gasUsed: bigint; message: `0x${string}` | null }
  | { ok: false; vmStatus: string };

/** Runs the burn against the chain as it is now, without a signature. Never sends anything. */
export async function simulateAptosBurn(
  args: AptosBurnArgs,
  envelope: AptosTxEnvelope,
): Promise<SimulationResult> {
  const res = await fetch(
    `${aptosRpcUrl()}/transactions/simulate?estimate_max_gas_amount=true&estimate_gas_unit_price=false`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/x.aptos.signed_transaction+bcs" }),
      body: Buffer.from(aptosSimulationBytes(args, envelope)),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    // A transaction the node will not even run (no gas, a stale sequence number) comes back as a
    // 400 with the VM's reason; that is a verdict on the burn, not the node being down.
    const e = body as { error_code?: string; message?: string } | null;
    if (res.status === 400 && e?.error_code === "vm_error" && typeof e.message === "string") {
      return { ok: false, vmStatus: e.message };
    }
    throw new Error(`the Aptos node answered ${res.status} to the simulation`);
  }
  const t = (Array.isArray(body) ? body[0] : body) as {
    success?: boolean;
    vm_status?: string;
    gas_used?: string;
    events?: Array<{ type?: string; data?: { message?: string } }>;
  } | null;
  if (!t || typeof t.success !== "boolean") throw new Error("unexpected simulation answer");
  if (!t.success) return { ok: false, vmStatus: String(t.vm_status ?? "unknown") };
  const sent = t.events?.find((e) => e.type?.endsWith("::message_transmitter::MessageSent"));
  const message = sent?.data?.message;
  return {
    ok: true,
    gasUsed: BigInt(t.gas_used ?? "0"),
    message:
      typeof message === "string" && /^0x[0-9a-f]+$/.test(message)
        ? (message as `0x${string}`)
        : null,
  };
}

/**
 * The envelope a wallet on the older signing interface needs (sequence number, gas, expiry), from
 * the node. Wallets on the current one fill these in themselves and ignore it.
 */
export async function aptosEnvelope(
  sender: `0x${string}`,
  sequenceNumber: bigint,
  now: number = Date.now(),
): Promise<AptosTxEnvelope> {
  return {
    sender,
    sequenceNumber,
    maxGasAmount: 20_000n,
    gasUnitPrice: await aptosGasPrice(),
    expirationTimestampSecs: BigInt(Math.floor(now / 1000) + EXPIRY_SECS),
    chainId: APTOS_CHAIN_ID,
  };
}

/** A max gas amount from a simulated use: twice it, and never under a floor. */
export function maxGasFor(gasUsed: bigint): bigint {
  const v = gasUsed * GAS_HEADROOM;
  return v > MIN_MAX_GAS ? v : MIN_MAX_GAS;
}

/** Plain words for the Move aborts a burn can hit. The raw status is kept alongside. */
export function describeVmStatus(vm: string): string {
  if (/INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE/i.test(vm)) {
    return "the wallet does not hold enough APT to pay the network fee";
  }
  if (/EINSUFFICIENT_BALANCE/i.test(vm)) {
    return "the wallet does not hold enough USDC for this amount";
  }
  if (/EFEE_EXCEEDS_MAX_FEE|EINSUFFICIENT_MAX_FEE|EINVALID_MAX_FEE/i.test(vm)) {
    return "Circle's fee does not fit this amount";
  }
  if (/paused|EPAUSED/i.test(vm)) return "Circle has paused CCTP on Aptos";
  if (/denylist|EDENYLISTED/i.test(vm)) return "this address cannot send USDC";
  if (/EBURN_AMOUNT_EXCEEDS_MAX|max_burn/i.test(vm))
    return "the amount is above Circle's per-burn limit";
  return "Aptos would reject the burn";
}
