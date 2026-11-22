"use client";

import { useState } from "react";
import { Notice } from "../../components/ui/notice";
import { useWallets } from "../../components/wallet/wallet-provider";
import { requestReattest } from "../../lib/circle-status";
import {
  type EvmClaimTarget,
  checkClaim,
  ensureClaimNetwork,
  isAlreadyMinted,
  sendClaim,
  waitForClaim,
} from "../../lib/evm-claim";
import { reportError } from "../../lib/format-error";

/**
 * The EVM half of `/claim`: complete an attested transfer from your own wallet, on whichever EVM
 * chain it was sent to.
 *
 * Deliberately parallel to the Solana flow on the same page rather than folded into it. The two
 * share a promise — the attestation is public, anyone may submit the mint — but nothing else: no
 * token account to create, no owner to be told, no rent. An EVM claim is connect, switch network,
 * sign once.
 *
 * One thing it has that the Solana flow does not: a Fast transfer's attestation runs out after
 * about a day. That is found by asking the chain whether the mint would succeed, and fixed by
 * asking Circle to sign again. The money was never at risk; the signature was only stale.
 */
export function EvmClaim({
  message,
  attestation,
  target,
  eventNonce,
  onReattested,
}: {
  message: `0x${string}`;
  attestation: `0x${string}`;
  target: EvmClaimTarget;
  /** What a fresh attestation is asked for by. Null when Circle did not report one. */
  eventNonce: string | null;
  /** Called once Circle has been asked to sign again, so the page can fetch the new attestation. */
  onReattested: () => void;
}) {
  // The shared EVM connection (picked in the wallet modal). Falls back to nothing: a claim signed by
  // a wallet the user did not choose is worse than asking them to choose one.
  const { connections, open, syncEvmChain } = useWallets();
  const evm = connections.evm;
  const provider = evm?.provider ?? null;
  const wallet = evm?.address ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [alreadyMinted, setAlreadyMinted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [refreshed, setRefreshed] = useState(false);

  async function claim() {
    if (!provider || !wallet) return;
    setError(null);
    setSent(null);
    setConfirming(false);
    try {
      // First, always. Circle's transmitter has the same address on every chain, so every question
      // below would be answered, wrongly, by whichever chain the wallet happened to be on.
      setBusy(`Switching to ${target.name}…`);
      await ensureClaimNetwork(provider, target);

      setBusy("Checking the transfer…");
      // The likeliest reason to be here with a valid attestation is that Circle's forwarding
      // service already delivered it. Say so, instead of letting the wallet warn that a transaction "will fail".
      if (await isAlreadyMinted(provider, target, message)) {
        setAlreadyMinted(true);
        return;
      }
      const check = await checkClaim(provider, target, wallet, message, attestation);
      if (!check.ok && check.expired) {
        setExpired(true);
        return;
      }
      if (!check.ok) {
        throw new Error(`${target.name} says this mint would fail: ${check.reason}`);
      }

      setBusy("Confirm in your wallet…");
      const sentHash = await sendClaim(provider, target, wallet, message, attestation);
      setSent(sentHash);

      setBusy(`Waiting for ${target.name}…`);
      try {
        const outcome = await waitForClaim(provider, sentHash);
        if (outcome !== "success") throw new Error(`the transaction ${sentHash} reverted on chain`);
        setHash(sentHash);
      } catch (waitErr) {
        const message = waitErr instanceof Error ? waitErr.message : String(waitErr);
        if (/no receipt|timeout/i.test(message)) {
          setConfirming(true);
        } else {
          throw waitErr;
        }
      }
    } catch (err) {
      setError(reportError("claim failed", err));
    } finally {
      setBusy(null);
      void syncEvmChain();
    }
  }

  async function refresh() {
    if (!eventNonce) return;
    setError(null);
    setBusy("Asking Circle to sign again…");
    const result = await requestReattest(eventNonce);
    setBusy(null);
    if (!result.ok) {
      setError(`Circle did not accept the request: ${result.reason}.`);
      return;
    }
    setRefreshed(true);
    onReattested();
  }

  if (alreadyMinted) {
    return (
      <Notice tone="signal" title="Already minted">
        Circle has already delivered this transfer — most likely its forwarding service got there
        first. Nothing is owed and there is nothing to claim.
      </Notice>
    );
  }

  if (hash) {
    return (
      <Notice tone="signal" title="Minted">
        <p className="break-all font-mono text-[0.75rem] text-bone/60">{hash}</p>
        <a
          href={`${target.explorerUrl}/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[0.8125rem] text-signal underline underline-offset-2"
        >
          View on the {target.name} explorer
        </a>
      </Notice>
    );
  }

  if (confirming && sent) {
    return (
      <Notice tone="info" title="Your claim was sent and is still confirming">
        <p className="break-all font-mono text-[0.75rem] text-bone/60">{sent}</p>
        <a
          href={`${target.explorerUrl}/tx/${sent}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[0.8125rem] text-bone/70 underline underline-offset-2 hover:text-bone"
        >
          View on the {target.name} explorer
        </a>
      </Notice>
    );
  }

  if (expired) {
    return (
      <>
        <Notice tone="info" title="This attestation has run out">
          This was a Fast transfer, and Circle&rsquo;s signature on one is good for about a day.
          Nothing is lost: the USDC is still burned and still owed. Circle signs it again on
          request, and the new signature can be claimed here in the usual way.
          {refreshed && (
            <p className="mt-2 text-bone/60">
              Circle has been asked. A fresh attestation usually takes a minute or two; look the
              transaction up again when it has.
            </p>
          )}
        </Notice>
        {!refreshed &&
          (eventNonce ? (
            <button
              type="button"
              onClick={refresh}
              disabled={Boolean(busy)}
              className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
            >
              {busy ?? "Ask Circle for a fresh attestation"}
            </button>
          ) : (
            <Notice tone="alarm" title="Cannot ask from here">
              Circle did not report the identifier a fresh attestation is requested by. Look the
              transaction up again in a moment.
            </Notice>
          ))}
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

  return (
    <>
      <Notice tone="signal" title={`Attested and claimable on ${target.name}`}>
        The funds are waiting. Submitting the mint costs you gas on {target.name}:{" "}
        {target.claimCost}. This is the cost Circle&rsquo;s delivery fee normally covers.
      </Notice>

      <section className="rounded-tray bg-bone/[0.03] px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium uppercase tracking-wider text-bone/40">
            Paying wallet
          </span>
          {wallet ? (
            <span className="break-all font-mono text-xs text-signal">{wallet}</span>
          ) : (
            <button
              type="button"
              onClick={() => open(["evm"])}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:opacity-40"
            >
              Connect wallet
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-bone/35">
          This wallet pays the gas and needs a little {target.nativeCurrency.symbol} on{" "}
          {target.name} for it. The USDC goes to whoever the burn named, which may be someone else
          entirely — that is how a stuck transfer can be rescued by a third party.
        </p>
      </section>

      <button
        type="button"
        onClick={claim}
        disabled={!wallet || Boolean(busy)}
        className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
      >
        {busy ?? "Claim it"}
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
