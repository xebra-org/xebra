import { solanaAddressToBytes32 } from "@xebra/sdk/core";

/**
 * The network half of Solana recipients: deriving the USDC token account and asking our own API
 * whether it exists. The pure address checks live in `@xebra/sdk/core`.
 */

// ---------------------------------------------------------------------------
// Associated token accounts
// ---------------------------------------------------------------------------

/**
 * CCTP's `mintRecipient` on Solana is the **token account address**, not the wallet address.
 *
 * Circle's `handle_receive_finalized_message` enforces it directly:
 *
 *     require_keys_eq!(ctx.accounts.recipient_token_account.key(), mint_recipient,
 *                      TokenMessengerError::InvalidMintRecipient);
 *
 * Passing a wallet address burns the USDC to a `mintRecipient` that can only ever be
 * satisfied by a token account living at that exact address. Since a wallet address is a
 * system account, satisfying it would mean converting the user's wallet into a token
 * account — so in practice the transfer becomes unmintable.
 *
 * That is not hypothetical: it happened on the first real mainnet transfer through this app,
 * which passed the wallet address straight through and stranded the funds.
 *
 * Users think in wallet addresses, so the UI still asks for one — and this derives the
 * associated token account from it.
 */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Derives the associated token account for `owner` holding `mint`.
 *
 * Uses @solana/web3.js rather than a hand-rolled derivation: `findProgramAddressSync` has to
 * reject points that fall on the ed25519 curve and bump-seed downward until it finds one that
 * does not, and getting that subtly wrong would produce a plausible-looking address that
 * nothing can ever spend from.
 */
export async function deriveAssociatedTokenAccount(
  ownerBase58: string,
  mintBase58: string = USDC_MINT_MAINNET,
): Promise<string> {
  const { PublicKey } = await import("@solana/web3.js");
  const owner = new PublicKey(ownerBase58);
  const mint = new PublicKey(mintBase58);
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return ata.toBase58();
}

export type RecipientStatus = "exists" | "missing" | "unknown";

export interface RecipientResolution {
  /** The wallet the user typed. */
  ownerAddress: string;
  /** The USDC token account CCTP will mint into — this is what `mintRecipient` must be. */
  tokenAccount: string;
  tokenAccountBytes: Uint8Array;
  /**
   * `exists`  — safe to burn.
   * `missing` — a price, not a block: CCTP does not create the token account, but Circle's
   *             Forwarding Service opens it during delivery, for a higher fee the burn carries.
   * `unknown` — the check failed. Not `missing`: conflating the two once reported a wallet plainly
   *             holding USDC as having no account. Not `exists` either, because the price depends
   *             on which it is, so the forms hold the transfer until a lookup succeeds.
   */
  status: RecipientStatus;
  reason?: string;
}

/**
 * Resolves a wallet address to the token account CCTP needs, via our own API route.
 *
 * The lookup deliberately does NOT hit Solana's RPC from the browser: that endpoint answers
 * the CORS preflight with 200 and then returns 403 on the actual POST whenever an `Origin`
 * header is present. Every browser-side check therefore failed, and the failure was being
 * reported as "no token account".
 */
export async function resolveRecipient(ownerBase58: string): Promise<RecipientResolution> {
  const res = await fetch(`/api/recipient?owner=${encodeURIComponent(ownerBase58)}`, {
    cache: "no-store",
  });
  const body = (await res.json()) as {
    tokenAccount?: string;
    status?: RecipientStatus;
    reason?: string;
    error?: string;
  };

  if (!res.ok || !body.tokenAccount) {
    throw new Error(body.error ?? `Could not resolve the recipient (${res.status})`);
  }

  const resolution: RecipientResolution = {
    ownerAddress: ownerBase58,
    tokenAccount: body.tokenAccount,
    tokenAccountBytes: solanaAddressToBytes32(body.tokenAccount),
    status: body.status ?? "unknown",
  };
  if (body.reason) resolution.reason = body.reason;
  return resolution;
}
