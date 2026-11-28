import { base58Decode, bytesToHex } from "../core/addresses/solana.js";
import { formatUsdcAmount } from "../core/amounts.js";
import { HYPERCORE } from "../core/hypercore.js";
import type { UnsignedTx } from "./types.js";

/**
 * The two Hyperliquid actions of a withdrawal through Xebra, unsigned: `sendToEvmWithData` (Circle
 * burns it on HyperEVM and delivers it) and Xebra's fee, a plain USDC send on HyperCore. Both are
 * EIP-712 "user-signed" actions: the wallet signs typed data, and the signed action is POSTed to
 * Hyperliquid's `/exchange`. No gas, no chain switch, no key held by Xebra.
 *
 * Field lists and order are Circle's ("Withdraw USDC from HyperCore to EVM chains" / "…to
 * Solana") and Hyperliquid's (exchange endpoint, UsdSend and SpotSend); `hypercore.test.ts` pins
 * them to vectors computed with another EIP-712 implementation and to Hyperliquid's own test.
 * Pure.
 */

type HyperliquidTx = Extract<UnsignedTx, { kind: "hyperliquid" }>;

/** Which HyperCore balance the USDC leaves: perps (`sourceDex: ""`) or spot. */
export type HyperliquidBalance = "perps" | "spot";

export type HyperliquidNetwork = "Mainnet" | "Testnet";

const DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const SEND_TO_EVM_WITH_DATA = [
  { name: "hyperliquidChain", type: "string" },
  { name: "token", type: "string" },
  { name: "amount", type: "string" },
  { name: "sourceDex", type: "string" },
  { name: "destinationRecipient", type: "string" },
  { name: "addressEncoding", type: "string" },
  { name: "destinationChainId", type: "uint32" },
  { name: "gasLimit", type: "uint64" },
  { name: "data", type: "bytes" },
  { name: "nonce", type: "uint64" },
];

const USD_SEND = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
];

const SPOT_SEND = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "token", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * CCTP domains a HyperCore withdrawal must never name here: Stellar (the USDC would be stuck for
 * good: Circle's contract cannot name Stellar's forwarder), Sui and Aptos (not yet tested), HyperEVM
 * itself, and the EVM chains Circle does not deliver to.
 */
const REFUSED_DOMAINS: readonly number[] = [27, 8, 9, 19, 29, 30, 31];
const SOLANA_DOMAIN = 5;

/** `"cctp-forward"`, right-padded with zeros to 24 bytes: the magic `CoreDepositWallet` looks for. */
const FORWARD_MAGIC = `${Array.from(new TextEncoder().encode("cctp-forward"), (b) =>
  b.toString(16).padStart(2, "0"),
).join("")}${"00".repeat(12)}`;

/**
 * The `data` of a withdrawal to Solana: Circle's forwarding magic, the open-account flag `01`, and
 * the 32-byte wallet that owns the recipient's USDC account, exactly as Circle's Solana how-to
 * builds it. The magic makes Circle forward it; the flag and owner let Circle open the account.
 */
export function solanaForwardData(owner: string): `0x${string}` {
  const bytes = base58Decode(owner.trim());
  if (bytes.length !== 32 || bytes.every((b) => b === 0)) {
    throw new Error("the Solana account owner must be a 32-byte public key");
  }
  return `0x${FORWARD_MAGIC}01${bytesToHex(bytes).slice(2)}`;
}

function checkTokenAccount(account: string): string {
  const t = account.trim();
  const bytes = base58Decode(t);
  if (bytes.length !== 32) throw new Error("the Solana token account must be 32 bytes");
  return t;
}

function checkEvm(address: string, what: string): string {
  const t = address.trim();
  if (!EVM_ADDRESS.test(t) || t.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${what} must be an EVM address (0x followed by 40 hex characters)`);
  }
  return t.toLowerCase();
}

function checkCommon(p: { amount: bigint; nonce: number; signatureChainId: number }): void {
  if (p.amount <= 0n) throw new Error("the amount must be more than zero");
  if (!Number.isSafeInteger(p.nonce) || p.nonce <= 0) {
    throw new Error("the nonce must be a whole number of milliseconds");
  }
  if (!Number.isSafeInteger(p.signatureChainId) || p.signatureChainId <= 0) {
    throw new Error("signatureChainId must be the wallet's chain id, a positive whole number");
  }
}

function typed(
  primaryType: string,
  fields: Array<{ name: string; type: string }>,
  chainId: number,
  message: Record<string, string | number>,
): HyperliquidTx["typedData"] {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: { EIP712Domain: DOMAIN_TYPES, [primaryType]: fields },
    primaryType,
    message,
  };
}

/** Who receives: an EVM address, or on Solana the USDC token account and the wallet that owns it. */
export type HyperliquidRecipient =
  | { encoding: "hex"; address: string }
  | { encoding: "base58"; tokenAccount: string; owner: string };

/**
 * The `sendToEvmWithData` action that withdraws `amount` (6-decimal units) from the user's
 * HyperCore balance to `destinationDomain`, delivered by Circle's Forwarding Service: `data` is
 * empty to an EVM chain (Circle's default forward) and the open-account hook to Solana.
 *
 * `signatureChainId` is the chain the wallet is on when it signs: wallets refuse typed data for
 * another chain, and Hyperliquid accepts any id as long as the action names the same one.
 */
export function buildHyperliquidWithdrawal(p: {
  amount: bigint;
  balance: HyperliquidBalance;
  destinationDomain: number;
  recipient: HyperliquidRecipient;
  nonce: number;
  signatureChainId: number;
  network?: HyperliquidNetwork;
}): HyperliquidTx {
  checkCommon(p);
  if (!Number.isSafeInteger(p.destinationDomain) || p.destinationDomain < 0) {
    throw new Error("destinationDomain must be a CCTP domain");
  }
  if (REFUSED_DOMAINS.includes(p.destinationDomain)) {
    throw new Error(
      `a Hyperliquid withdrawal is not sent to CCTP domain ${p.destinationDomain} (not delivered there, or stuck for good)`,
    );
  }
  const toSolana = p.destinationDomain === SOLANA_DOMAIN;
  let destinationRecipient: string;
  let data: `0x${string}`;
  if (toSolana) {
    if (p.recipient.encoding !== "base58") {
      throw new Error("a withdrawal to Solana names the Solana USDC token account and its owner");
    }
    destinationRecipient = checkTokenAccount(p.recipient.tokenAccount);
    data = solanaForwardData(p.recipient.owner);
  } else {
    if (p.recipient.encoding !== "hex") {
      throw new Error("a withdrawal to an EVM chain names an EVM address");
    }
    destinationRecipient = checkEvm(p.recipient.address, "the recipient");
    data = "0x";
  }
  const hyperliquidChain = p.network ?? "Mainnet";
  const message = {
    hyperliquidChain,
    token: "USDC",
    amount: formatUsdcAmount(p.amount),
    sourceDex: p.balance === "spot" ? "spot" : "",
    destinationRecipient,
    addressEncoding: toSolana ? "base58" : "hex",
    destinationChainId: p.destinationDomain,
    gasLimit: HYPERCORE.gasLimit,
    data,
    nonce: p.nonce,
  };
  return {
    kind: "hyperliquid",
    exchangeUrl: HYPERCORE.exchangeUrl,
    nonce: p.nonce,
    action: {
      type: "sendToEvmWithData",
      signatureChainId: `0x${p.signatureChainId.toString(16)}`,
      ...message,
    },
    typedData: typed(
      "HyperliquidTransaction:SendToEvmWithData",
      SEND_TO_EVM_WITH_DATA,
      p.signatureChainId,
      message,
    ),
  };
}

/**
 * Xebra's fee, from the same balance the withdrawal leaves: a `usdSend` from perps, a `spotSend`
 * of USDC from spot. Signed with the withdrawal, its nonce one after the withdrawal's, and sent to
 * Hyperliquid after it.
 */
export function buildHyperliquidFee(p: {
  feeAddress: string;
  amount: bigint;
  balance: HyperliquidBalance;
  nonce: number;
  signatureChainId: number;
  network?: HyperliquidNetwork;
}): HyperliquidTx {
  checkCommon(p);
  const destination = checkEvm(p.feeAddress, "Xebra's fee address");
  const hyperliquidChain = p.network ?? "Mainnet";
  const amount = formatUsdcAmount(p.amount);
  const spot = p.balance === "spot";
  const message: Record<string, string | number> = spot
    ? { hyperliquidChain, destination, token: HYPERCORE.spotUsdcToken, amount, time: p.nonce }
    : { hyperliquidChain, destination, amount, time: p.nonce };
  return {
    kind: "hyperliquid",
    exchangeUrl: HYPERCORE.exchangeUrl,
    nonce: p.nonce,
    action: {
      type: spot ? "spotSend" : "usdSend",
      signatureChainId: `0x${p.signatureChainId.toString(16)}`,
      ...message,
    },
    typedData: spot
      ? typed("HyperliquidTransaction:SpotSend", SPOT_SEND, p.signatureChainId, message)
      : typed("HyperliquidTransaction:UsdSend", USD_SEND, p.signatureChainId, message),
  };
}

/**
 * The body `POST /exchange` takes for a signed action: the action, its nonce, and the 65-byte
 * signature split into `r`, `s` and `v` (27 or 28). Send it as JSON to `tx.exchangeUrl`.
 */
export function hyperliquidExchangeBody(
  tx: HyperliquidTx,
  signature: string,
): {
  action: HyperliquidTx["action"];
  nonce: number;
  signature: { r: `0x${string}`; s: `0x${string}`; v: 27 | 28 };
} {
  if (!SIGNATURE.test(signature)) throw new Error("the signature must be 65 bytes of hex");
  const raw = Number.parseInt(signature.slice(130, 132), 16);
  const v = raw === 0 || raw === 27 ? 27 : raw === 1 || raw === 28 ? 28 : null;
  if (v === null) throw new Error("the signature's recovery id is not 0, 1, 27 or 28");
  return {
    action: tx.action,
    nonce: tx.nonce,
    signature: {
      r: `0x${signature.slice(2, 66).toLowerCase()}`,
      s: `0x${signature.slice(66, 130).toLowerCase()}`,
      v,
    },
  };
}
