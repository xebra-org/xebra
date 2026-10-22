import { type EvmChainId, isEvmChainId } from "./evm-chains";

/**
 * A link that opens the bridge already filled in: `/?from=stellar&to=base&amount=25&recipient=0x…`.
 *
 * It is how a phone lands in the right state, and how an assistant (the MCP server's
 * `create_transfer_link`) hands a transfer to a person to sign. It only ever *prefills*. Nothing in a
 * link signs, submits, or connects a wallet, and the page says plainly that the fields came from a
 * link, so a recipient swapped into a forwarded URL is something the sender is told to check.
 *
 * Parsing never throws and drops what it cannot trust: an unknown chain, an amount that is not a
 * plain positive decimal, a recipient that is not one short token. The forms still run their own
 * address checks on whatever survives.
 */
export interface DeepLink {
  from?: "stellar" | EvmChainId;
  to?: "solana" | EvmChainId;
  /** A decimal USDC amount, at most 6 places, as typed. */
  amount?: string;
  recipient?: string;
}

/** Plain decimal, no sign, no exponent, no separators. USDC has six places on every route. */
const AMOUNT = /^(?=.*[1-9])\d{1,12}(\.\d{1,6})?$/;
/** An address is one token. Long enough for every format here (a Stellar strkey is 56). */
const RECIPIENT = /^\S{1,100}$/;

export function parseDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const link: DeepLink = {};

  const from = params.get("from")?.trim().toLowerCase() ?? "";
  if (from === "stellar" || isEvmChainId(from)) link.from = from;

  const to = params.get("to")?.trim().toLowerCase() ?? "";
  if (to === "solana" || isEvmChainId(to)) link.to = to;

  const amount = params.get("amount")?.trim();
  if (amount && AMOUNT.test(amount)) link.amount = amount;

  const recipient = params.get("recipient")?.trim();
  if (recipient && RECIPIENT.test(recipient)) link.recipient = recipient;

  return link;
}

/** The inverse. Leaves out what is not set, so a link carries only what it means to prefill. */
export function buildDeepLink(origin: string, link: DeepLink): string {
  const params = new URLSearchParams();
  if (link.from) params.set("from", link.from);
  if (link.to) params.set("to", link.to);
  if (link.amount) params.set("amount", link.amount);
  if (link.recipient) params.set("recipient", link.recipient);
  const query = params.toString();
  return `${origin.replace(/\/+$/, "")}/${query ? `?${query}` : ""}#bridge`;
}

/** Whether a link set anything at all. */
export const hasDeepLink = (link: DeepLink): boolean => Object.keys(link).length > 0;
