"use client";

import { useState } from "react";
import { Notice } from "../../components/ui/notice";
import { useWallets } from "../../components/wallet/wallet-provider";
import { reportError } from "../../lib/format-error";
import { signAndExecuteSui } from "../../lib/wallets/sui";

/** What `/api/attestation` reads from a Sui-bound message. */
export interface SuiClaimTarget {
  /** The Sui address the USDC is minted to. */
  recipient: string;
  /** What lands with the recipient, as a decimal string in USDC. */
  receivedUsdc: string;
}

type Built =
  | { status: "ready"; transaction: string; recipient: string; receivedUsdc: string }
  | { status: "already-minted" }
  | { status: "paused"; error: string };

/**
 * The Sui half of `/claim`: mint a transfer that was sent to Sui, from any Sui wallet.
 *
 * Circle's Forwarding Service does not deliver to Sui, so this is not a fallback for a failed
 * delivery; it is how every transfer into Sui ends. One wallet prompt: the server builds Circle's
 * mint (`/api/sui-mint/build`), having already run it once without executing it, and the wallet
 * signs and submits it. The signer pays a little SUI for gas and gets nothing else; the USDC goes to
 * the address the burn named.
 */
export function SuiClaim({
  message,
  attestation,
  target,
}: {
  message: string;
  attestation: string;
  target: SuiClaimTarget;
}) {
  const { sui: signer, open } = useWallets();
  const account = signer?.account ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [alreadyMinted, setAlreadyMinted] = useState(false);

  async function claim() {
    if (!signer || !account) return;
    setError(null);
    try {
      setBusy("Checking the transfer…");
      const res = await fetch("/api/sui-mint/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: account.address, message, attestation }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Built> & { error?: string };
      if (body.status === "already-minted") {
        setAlreadyMinted(true);
        return;
      }
      if (body.status !== "ready" || !body.transaction) {
        throw new Error(body.error ?? `the server answered ${res.status}`);
      }
      // The recipient Circle signed for, read again by the server. Never sign a mint that says
      // anything different from what this page showed.
      if (body.recipient !== target.recipient) {
        throw new Error("the transfer's recipient does not match what this page showed");
      }
      setBusy("Confirm in your wallet…");
      setDigest(await signAndExecuteSui(signer.wallet, account, body.transaction));
    } catch (err) {
      setError(reportError("claim failed", err));
    } finally {
      setBusy(null);
    }
  }

  if (alreadyMinted) {
    return (
      <Notice tone="signal" title="Already minted">
        This transfer is already on Sui. Nothing is owed and there is nothing to claim.
      </Notice>
    );
  }

  if (digest) {
    return (
      <Notice tone="signal" title="Minted">
        <p className="break-all font-mono text-[0.75rem] text-bone/60">{digest}</p>
        <a
          href={`https://suiscan.xyz/mainnet/tx/${digest}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[0.8125rem] text-signal underline underline-offset-2"
        >
          View on Suiscan
        </a>
      </Notice>
    );
  }

  return (
    <>
      <Notice tone="signal" title="Ready to claim on Sui">
        {target.receivedUsdc} USDC is waiting for{" "}
        <span className="break-all font-mono text-[0.75rem]">{target.recipient}</span>. Circle does
        not deliver to Sui by itself, so one Sui transaction finishes it. It costs a little SUI for
        gas, usually under 0.01 SUI.
      </Notice>

      <section className="rounded-tray bg-bone/[0.03] px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium uppercase tracking-wider text-bone/40">
            Paying wallet
          </span>
          {account ? (
            <span className="break-all font-mono text-xs text-signal">{account.address}</span>
          ) : (
            <button
              type="button"
              onClick={() => open(["sui"])}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:opacity-40"
            >
              Connect Sui wallet
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-bone/35">
          This wallet pays the gas. The USDC goes to the address above, whichever wallet signs, so
          anyone can finish a transfer for someone else.
        </p>
      </section>

      <button
        type="button"
        onClick={claim}
        disabled={!account || Boolean(busy)}
        className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
      >
        {busy ?? "Claim on Sui"}
      </button>

      {error && (
        <Notice tone="alarm" title="That did not go through">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
            {error}
          </pre>
        </Notice>
      )}
    </>
  );
}
