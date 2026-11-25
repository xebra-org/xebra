import { getAddress } from "viem";
import type { RecipientResolution } from "../../lib/solana-recipient";
import type { Connection, Family } from "../../lib/wallets/types";
import { cn } from "../ui/cn";
import { InsetTray } from "../ui/glass-card";
import { Check } from "../ui/icons";
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
 * A Sui recipient, and what finishing the transfer takes. Said before signing because it is the one
 * route where the transfer does not finish by itself: Circle does not deliver to Sui.
 */
/** Xebra's offer to finish a Sui transfer and pay its gas, when this deployment runs the relayer. */
export interface SuiGasOffer {
  /** Whether the person ticked the box. */
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}

export function SuiRecipientPanel({
  address,
  valid,
  gas,
}: {
  address: string;
  valid: boolean;
  /** Absent when Xebra does not pay Sui gas here; the transfer is then claimed by hand. */
  gas?: SuiGasOffer;
}) {
  if (!valid) return null;
  const paid = gas?.on === true;
  return (
    <InsetTray className="mt-3 py-3">
      <p className="text-xs text-bone/40">USDC will be minted to this Sui address</p>
      <p className="tabular mt-1.5 break-all font-mono text-xs text-bone/70">
        {address.toLowerCase()}
      </p>
      {gas && (
        <label className="group mt-3 flex cursor-pointer items-start gap-3 border-t border-bone/[0.06] pt-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <input
            type="checkbox"
            checked={gas.on}
            disabled={gas.disabled}
            onChange={(e) => gas.onChange(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cn(
              "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.3rem] border",
              "transition-colors duration-200 ease-haptic peer-focus-visible:ring-1 peer-focus-visible:ring-bone/40",
              gas.on
                ? "border-bone bg-bone text-obsidian"
                : "border-bone/30 group-hover:border-bone/55",
            )}
          >
            {gas.on && <Check className="h-3 w-3" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium tracking-[-0.01em] text-bone">
              Pay the Sui network fee for me
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-bone/45">
              Xebra finishes the transfer on Sui as soon as Circle signs it, and pays the gas. No
              Sui wallet or SUI needed.
            </span>
          </span>
        </label>
      )}
      {!paid && (
        <p className="mt-2.5 text-xs leading-relaxed text-bone/45">
          One more step on Sui: Circle does not deliver there by itself. A few minutes after you
          send, the receipt links to the claim page, where any Sui wallet finishes it for a little
          SUI gas. The USDC goes to this address whoever signs.
        </p>
      )}
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
  family: "solana" | "evm" | "sui";
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
          Connect {family === "solana" ? "a Solana" : family === "sui" ? "a Sui" : "an EVM"} wallet
          to fill this in
        </button>
      )}
    </div>
  );
}
