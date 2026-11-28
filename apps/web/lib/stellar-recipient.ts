import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { isMuxedStellarAddress, stellarAccountOf } from "@xebra/sdk/core";

/**
 * A recipient for a transfer into Stellar, from any chain: a G... account, or a muxed M... address
 * (a G... account plus a numeric id: the deposit address an exchange hands out). Circle's
 * CctpForwarder pays either; the hook carries the text whole, so the id reaches the exchange.
 *
 * C... contracts stay refused on these routes: a contract has no trustline to check before the
 * burn, and a mint the forwarder cannot pay leaves the USDC waiting.
 *
 * One wording for every surface (the API, the Sui, Solana and Aptos builds, the forms), so a
 * person sees the same sentence wherever they paste the address.
 */

export const STELLAR_RECIPIENT_FORMAT =
  "The recipient must be a Stellar account address starting with G, or an exchange deposit address starting with M.";

export interface StellarRecipient {
  /** What goes into the hook: the address as given. */
  address: string;
  /** The G... account whose trustline is checked: the address itself, or the one an M... is of. */
  account: string;
  muxed: boolean;
  /** The deposit id an M... address carries (a 64-bit number, as text); null for a G... account. */
  id: string | null;
}

/** The recipient, read, or null when it is neither a G... account nor an M... address. */
export function readStellarRecipient(raw: string): StellarRecipient | null {
  const address = raw.trim();
  if (StrKey.isValidEd25519PublicKey(address)) {
    return { address, account: address, muxed: false, id: null };
  }
  if (!isMuxedStellarAddress(address)) return null;
  const account = stellarAccountOf(address);
  if (!account) return null;
  return { address, account, muxed: true, id: MuxedAccount.fromAddress(address, "0").id() };
}

/**
 * Why the account behind `r` cannot receive USDC yet, or null when it can. For an M... address it
 * names the G... account the trustline belongs to, since that is not the text the person pasted.
 */
export function stellarRecipientProblem(
  r: StellarRecipient,
  account: { exists: boolean; hasTrustline: boolean },
): string | null {
  if (account.exists && account.hasTrustline) return null;
  const who = r.muxed
    ? `That deposit address belongs to the Stellar account ${r.account}, which`
    : "That Stellar account";
  if (!account.exists) {
    return `${who} does not exist yet. It needs XLM to be created and a USDC trustline before it can receive.`;
  }
  return r.muxed
    ? `${who} has no USDC trustline. Check with the exchange that it takes USDC on Stellar.`
    : `${who} has no USDC trustline. Add one, then try again.`;
}

/** The recipient field's words, the same on every form that sends into Stellar. */
export const STELLAR_RECIPIENT_PLACEHOLDER = "G... or M...";
export const STELLAR_RECIPIENT_INVALID =
  "That is not a Stellar account (G...) or exchange deposit address (M...).";
const PLAIN_HINT =
  "An existing account that already holds a USDC trustline. Starts with G, or M for an exchange deposit address.";

/**
 * The hint under the field. For an M... address it spells out what the person pasted: the account
 * the USDC lands in and the deposit id the exchange credits it by, so a wrong id is visible before
 * anything is burned.
 */
export function stellarRecipientHint(raw: string): string {
  const r = readStellarRecipient(raw);
  if (!r?.muxed) return PLAIN_HINT;
  const account = `${r.account.slice(0, 6)}…${r.account.slice(-6)}`;
  return `Exchange deposit address: account ${account}, deposit id ${r.id}. Check the id matches the one the exchange shows you; that account must take USDC on Stellar.`;
}
