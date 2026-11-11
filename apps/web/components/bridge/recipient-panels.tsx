import { getAddress } from "viem";
import type { RecipientResolution } from "../../lib/solana-recipient";
import type { Connection, Family } from "../../lib/wallets/types";
import { InsetTray } from "../ui/glass-card";
import { Notice } from "../ui/notice";

/**
 * Arc's counterpart of `RecipientPanel`, and much smaller because there is less to resolve.
 *
 * Nothing needs looking up — an Arc mint credits the address directly — so this only shows the
 * one thing worth a second look before a burn nobody can undo: the address exactly as it will be
 * used, in its checksummed form. A typo that survives validation shows up as a different string
 * here, in a different case pattern, which is easier to notice than in the box it was typed into.
 */
export function ArcRecipientPanel({
  address,
  valid,
  chainName = "Arc",
}: {
  address: string;
  valid: boolean;
  /** Any EVM chain mints the same way; Arc is only the first one this was written for. */
  chainName?: string;
}) {
  if (!valid) return null;
  return (
    <InsetTray className="mt-3 py-3">
      <p className="text-xs text-bone/40">USDC will be minted to this {chainName} address</p>
      <p className="tabular mt-1.5 break-all font-mono text-xs text-bone/70">
        {getAddress(address)}
      </p>
    </InsetTray>
  );
}

/**
 * Shows what the USDC will actually be delivered to.
 *
 * Users type a wallet address, but CCTP's `mintRecipient` on Solana must be the USDC **token
 * account** — Circle enforces `recipient_token_account.key() == mint_recipient`. Passing a
 * wallet address strands the transfer permanently, which is exactly what happened on the
 * first real mainnet burn through this app.
 *
 * Since the address the user types is not the address that receives, the derived one is shown
 * rather than hidden. CCTP itself does not create the token account; Circle's Forwarding Service
 * does, during delivery and for a higher fee. So its absence is shown as a price before signing,
 * and a lookup that failed holds the transfer, instead of either being discovered after the burn.
 */
export function RecipientPanel({
  resolving,
  recipient,
  addressValid,
}: {
  resolving: boolean;
  recipient: RecipientResolution | null;
  addressValid: boolean;
}) {
  if (!addressValid) return null;

  if (resolving || !recipient) {
    return <p className="mt-3 text-[0.8125rem] text-bone/40">Checking the recipient account…</p>;
  }

  // A missing account is a price, not a wall: Circle opens it while delivering, and its fee for that
  // is already inside the fee shown above.
  if (recipient.status === "missing") {
    return (
      <Notice tone="info" title="Circle will open this wallet's USDC account" className="mt-3">
        First transfer to this wallet, so its USDC account does not exist yet. Circle creates it as
        part of delivery, and the fee above already covers that. It is a one-off — later transfers
        skip it. To move the USDC on afterwards, the wallet will need a little SOL for network fees.
        <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
          {recipient.tokenAccount}
        </p>
      </Notice>
    );
  }

  // A failed lookup must not read as "no account" (that blocked a wallet that plainly held USDC),
  // and it must not read as "has one" either: the price and the delivery both depend on which it
  // is, so the transfer waits until the lookup succeeds.
  if (recipient.status === "unknown") {
    return (
      <Notice tone="info" title="Could not check the recipient account" className="mt-3">
        The Solana lookup failed{recipient.reason ? `: ${recipient.reason}` : ""}. Bridging stays
        off until it succeeds, because whether this wallet already has a USDC account changes what
        delivery costs. Change the address or wait a moment and it will retry.
        <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
          {recipient.tokenAccount}
        </p>
      </Notice>
    );
  }

  return (
    <div className="mt-3 rounded-tray bg-bone/[0.03] px-4 py-3">
      <p className="text-[0.8125rem] text-bone/50">Delivered to this wallet&apos;s USDC account:</p>
      <p className="mt-1 break-all font-mono text-[0.75rem] text-bone/60">
        {recipient.tokenAccount}
      </p>
    </div>
  );
}

/**
 * One tap to send to yourself: fills the recipient from a connected wallet of the destination's own
 * kind. It only fills the field. Everything after (validation, the token-account lookup, the
 * address shown back before signing) is the same as for a typed address, so a wrong wallet is
 * caught by the same checks.
 */
export function UseMyWallet({
  family,
  connection,
  disabled,
  onUse,
  onConnect,
}: {
  family: "solana" | "evm";
  connection: Connection | undefined;
  disabled: boolean;
  onUse: (address: string) => void;
  onConnect: (families: readonly Family[]) => void;
}) {
  return (
    <div className="mt-2 px-1 text-[0.8125rem] text-bone/45">
      {connection ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onUse(connection.address)}
          className="underline underline-offset-4 transition-colors hover:text-bone disabled:opacity-40"
        >
          Use my {connection.walletName} address ({connection.address.slice(0, 4)}…
          {connection.address.slice(-4)})
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onConnect([family])}
          className="underline underline-offset-4 transition-colors hover:text-bone disabled:opacity-40"
        >
          Connect {family === "solana" ? "a Solana" : "an EVM"} wallet to fill this in
        </button>
      )}
    </div>
  );
}
