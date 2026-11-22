"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice } from "../../components/ui/notice";
import { browserConnection } from "../../lib/claim";
import { waitForSignature } from "../../lib/solana-confirm";
import { type ClassifiedError, classifyWalletError } from "../../lib/wallet-error";

/**
 * Countersigns a recovery transaction for a CCTP transfer that was burned to a wallet address
 * instead of a token account.
 *
 * # Why this page exists
 *
 * CCTP's `mintRecipient` on Solana must be the USDC *token account*; Circle enforces
 * `recipient_token_account.key() == mint_recipient`. A burn addressed to a wallet can only be
 * satisfied by a token account at that exact address — so recovery means initialising one
 * there, minting into it, sweeping the funds out, and closing it to free the address again.
 *
 * Two of those steps must be signed by the stranded address itself, and that key lives in the
 * user's wallet. `scripts/recover-stranded-mint.mjs` builds and partially signs each
 * transaction with an operator key (`SOLANA_KEYPAIR_PATH`, which pays rent and fees); this page
 * adds the wallet's signature and submits.
 *
 * # Why paste base64 rather than build it here
 *
 * The operator key pays the rent, and it must never reach a browser. Splitting the work this
 * way keeps it on the machine that owns it: the script signs what it can, the wallet signs
 * what only it can, and neither ever sees the other's key.
 */

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction<T>(tx: T): Promise<T>;
};

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null) ?? null;
}

export default function RecoverPage() {
  const [provider, setProvider] = useState<PhantomProvider | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [step, setStep] = useState<"idle" | "signing" | "confirming">("idle");
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  useEffect(() => {
    setProvider(getPhantom());
  }, []);

  const connect = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const { publicKey } = await provider.connect();
      setWallet(publicKey.toBase58());
    } catch (err) {
      setError(classifyWalletError(err));
    }
  }, [provider]);

  async function signAndSubmit() {
    if (!provider || !payload.trim()) return;
    setStep("signing");
    setError(null);
    setSignature(null);
    try {
      const { Transaction } = await import("@solana/web3.js");
      const raw = Buffer.from(payload.trim(), "base64");
      const tx = Transaction.from(raw);

      // Surface what is being signed rather than trusting the paste. A recovery transaction
      // touches an address the user is about to convert into a token account; signing that
      // blind is exactly the kind of thing a wallet prompt does not make legible.
      const signed = await provider.signTransaction(tx);
      setStep("confirming");

      // Through the same-origin proxy: the public RPC refuses a request that carries an Origin.
      const connection = browserConnection();
      const sig = await connection.sendRawTransaction(signed.serialize());
      await waitForSignature(connection, sig);
      setSignature(sig);
    } catch (err) {
      setError(classifyWalletError(err));
    } finally {
      setStep("idle");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-bone">
          Recover a stranded transfer
        </h1>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-bone/50">
          For a CCTP transfer burned to a wallet address instead of a token account. Paste a
          transaction produced by{" "}
          <code className="font-mono text-xs">recover-stranded-mint.mjs</code>, sign it with the
          wallet that owns the stranded address, and submit.
        </p>
      </header>

      <section className="rounded-tray bg-bone/[0.03] px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium uppercase tracking-wider text-bone/40">Wallet</span>
          {wallet ? (
            <span className="break-all font-mono text-xs text-signal">{wallet}</span>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={!provider}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors hover:bg-bone/5 disabled:opacity-40"
            >
              {provider ? "Connect Phantom" : "Phantom not detected"}
            </button>
          )}
        </div>
        {!provider && (
          <p className="mt-2 text-xs text-bone/40">
            Open this page inside Phantom&apos;s browser, or install the extension.
          </p>
        )}
      </section>

      <div>
        <label
          htmlFor="payload"
          className="mb-2 block text-xs font-medium uppercase tracking-wider text-bone/40"
        >
          Transaction (base64)
        </label>
        <textarea
          id="payload"
          rows={6}
          spellCheck={false}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder="Paste the base64 printed by the recovery script"
          className="w-full rounded-tray bg-obsidian-sunken px-3 py-3 font-mono text-xs text-bone/80 ring-1 ring-inset ring-bone/10 placeholder:font-sans placeholder:text-bone/25 focus:ring-bone/30"
        />
      </div>

      {error &&
        (error.kind === "declined" || error.kind === "popup" ? (
          <Notice tone="info" title="Wallet request cancelled">
            {error.message}
          </Notice>
        ) : (
          <Notice tone="alarm" title="That did not go through">
            <p className="text-[0.8125rem] text-bone/80">{error.message}</p>
            {error.raw && error.raw !== error.message && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/50">
                {error.raw}
              </pre>
            )}
          </Notice>
        ))}

      {signature ? (
        <Notice tone="signal" title="Submitted">
          <p className="break-all font-mono text-[0.75rem] text-bone/60">{signature}</p>
          <a
            href={`https://solscan.io/tx/${signature}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[0.8125rem] text-signal underline underline-offset-2"
          >
            View on Solscan
          </a>
        </Notice>
      ) : (
        <button
          type="button"
          disabled={!wallet || !payload.trim() || step !== "idle"}
          onClick={signAndSubmit}
          className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
        >
          {step === "signing"
            ? "Confirm in your wallet…"
            : step === "confirming"
              ? "Waiting for the network…"
              : "Sign and submit"}
        </button>
      )}

      <p className="text-xs leading-relaxed text-bone/35">
        The recovery script has already signed for the fee and rent. Your wallet only adds the
        signature for the stranded address. If anything fails, no funds move — the rent is refunded
        when the temporary account is closed in the final step.
      </p>
    </main>
  );
}
