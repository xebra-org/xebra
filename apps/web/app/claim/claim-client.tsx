"use client";

import type { Transaction } from "@solana/web3.js";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Notice } from "../../components/ui/notice";
import { browserConnection, buildMintTransaction, prepareClaim } from "../../lib/claim";
import { EVM_CHAINS, evmChainForDomain } from "../../lib/evm-chains";
import type { EvmClaimTarget } from "../../lib/evm-claim";
import { reportError } from "../../lib/format-error";
import { waitForSignature } from "../../lib/solana-confirm";
import { EvmClaim } from "./evm-claim";

/**
 * Completes a transfer from the user's own wallet, when Circle's forwarding did not.
 *
 * # Why this page is the point
 *
 * The product promises funds cannot hang: once Circle attests a burn, the `(message, attestation)`
 * pair is public and anyone can submit `receiveMessage` to mint to the recipient. Before this page
 * that was true and unusable — if delivery failed the receipt told you to keep your hash and wait
 * for a human to run a script, which made our uptime your risk rather than your convenience.
 * There is no relay any more: a forward that fails is claimed here, by the owner.
 *
 * Distinct from `/recover`, which countersigns a transaction our recovery script partly signed,
 * for a burn addressed to a wallet instead of a token account. That is a rescue from a specific
 * past bug.
 * This is the path when a forward failed or was never requested.
 *
 * # Which chain the burn was on
 *
 * A burn made on Stellar is found by its hash alone, as it always was. One made on an EVM chain
 * has to say which, because the same hash could be a transaction on any of them; a link from a
 * receipt carries it (`&src=`), and someone arriving with only a hash picks it from the list.
 * Where the mint is submitted is not asked: it is read from Circle's attested message.
 *
 * # What a Solana claim costs the person clicking
 *
 * (An EVM claim is the destination chain's gas, and nothing else: `evm-claim.tsx`.)
 *
 * The transaction fee plus 695,960 lamports of permanent `used_nonce` rent — about 0.0007 SOL —
 * and roughly 0.0015 SOL more if the recipient has no USDC account yet. None of it is recoverable
 * by anyone. That is what Circle's delivery fee normally covers, stated rather than hidden, because
 * the person paying it is about to approve it in a wallet prompt that will not explain it.
 *
 * A recipient with no USDC account takes two wallet prompts, opening the account and then the
 * mint, because the two do not fit in one Solana transaction (`lib/claim.ts`).
 */

type PhantomProvider = {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
};

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null) ?? null;
}

type Attestation =
  | {
      status: "complete";
      message: string;
      attestation: string;
      usdcMint: string;
      sourceDomainId: number;
      /** Read from the message itself, so it is the destination Circle will enforce. */
      destinationDomain: number;
      /** What a fresh attestation is requested by, should this one have run out. */
      eventNonce?: string | null;
      /** Present for a message bound for any EVM chain: where to submit the mint. */
      evm?: EvmClaimTarget;
    }
  | { status: "pending" }
  | { status: "unknown"; reason?: string };

const STELLAR_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
/** Solana's CCTP domain. The one destination claimed with a Solana wallet instead of an EVM one. */
const SOLANA_DOMAIN = 5;

/** Where the burn was made: "stellar", or an EVM chain's CCTP domain as a string. */
type Source = string;
const STELLAR: Source = "stellar";

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: STELLAR, label: "Stellar" },
  ...Object.values(EVM_CHAINS).map((c) => ({ value: String(c.cctpDomainId), label: c.name })),
];

/** A Solana-bound message is the only kind the Phantom flow below can submit. */
function isSolanaBound(a: { destinationDomain: number; evm?: EvmClaimTarget }): boolean {
  return !a.evm && a.destinationDomain === SOLANA_DOMAIN;
}

/**
 * The interactive claim. `app/claim/page.tsx` renders it inside Suspense, with the page's intro as
 * the fallback, so the server HTML carries the page's words while this waits for the query string.
 */
export function ClaimClient() {
  const params = useSearchParams();
  const [txHash, setTxHash] = useState("");
  const [source, setSource] = useState<Source>(STELLAR);
  const [provider, setProvider] = useState<PhantomProvider | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [recipientOwner, setRecipientOwner] = useState("");
  const [needsOwner, setNeedsOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [alreadyMinted, setAlreadyMinted] = useState(false);

  useEffect(() => setProvider(getPhantom()), []);

  // Arriving from the receipt carries the hash, so the common path is one click rather than a
  // copy-paste of 64 characters.
  useEffect(() => {
    const fromLink = params.get("tx")?.trim().toLowerCase();
    const src = params.get("src");
    const chain = src !== null && /^\d+$/.test(src) ? evmChainForDomain(Number(src)) : null;
    if (chain) {
      setSource(String(chain.cctpDomainId));
      if (fromLink && EVM_HASH.test(fromLink)) setTxHash(fromLink);
    } else if (fromLink && STELLAR_HASH.test(fromLink)) {
      setTxHash(fromLink);
    }
  }, [params]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const { publicKey } = await provider.connect();
      setWallet(publicKey.toBase58());
    } catch (err) {
      setError(reportError("wallet connect failed", err));
    }
  }, [provider]);

  async function lookUp() {
    const hash = txHash.trim().toLowerCase();
    const onStellar = source === STELLAR;
    if (!(onStellar ? STELLAR_HASH : EVM_HASH).test(hash)) {
      setError(
        onStellar
          ? EVM_HASH.test(hash)
            ? "That looks like a transaction on an EVM chain. Choose the chain it was burned on above."
            : "That is not a Stellar transaction hash — expected 64 hex characters."
          : `That is not a ${SOURCES.find((s) => s.value === source)?.label ?? "chain"} transaction hash — expected 0x followed by 64 hex characters.`,
      );
      return;
    }
    setBusy("Asking Circle for the attestation…");
    setError(null);
    setAttestation(null);
    setNeedsOwner(null);
    setAlreadyMinted(false);
    try {
      const query = new URLSearchParams({ tx: hash });
      if (!onStellar) query.set("src", source);
      const res = await fetch(`/api/attestation?${query}`);
      setAttestation((await res.json()) as Attestation);
    } catch (err) {
      setError(reportError("could not reach Circle", err));
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    if (!provider || !wallet || attestation?.status !== "complete") return;
    setBusy("Building the transaction…");
    setError(null);
    try {
      const connection = browserConnection();
      const input = {
        message: attestation.message,
        attestation: attestation.attestation,
        usdcMint: attestation.usdcMint,
        sourceDomainId: attestation.sourceDomainId,
        payer: wallet,
        ...(recipientOwner.trim() ? { recipientOwner: recipientOwner.trim() } : {}),
      };
      const prepared = await prepareClaim(connection, input);

      if (prepared.status === "already-minted") {
        setAlreadyMinted(true);
        return;
      }
      if (prepared.status === "needs-owner") {
        setNeedsOwner(prepared.reason);
        return;
      }
      setNeedsOwner(null);

      /** Signs, submits and waits, so the next step only starts on a landed transaction. */
      const submit = async (transaction: Transaction, step: string) => {
        setBusy(`${step}: confirm in your wallet…`);
        const signed = await provider.signTransaction(transaction);
        setBusy(`${step}: submitting…`);
        const sig = await connection.sendRawTransaction(signed.serialize());
        setBusy(`${step}: waiting for Solana…`);
        await waitForSignature(connection, sig);
        return sig;
      };

      if (prepared.setup) await submit(prepared.setup, "Opening the USDC account (1 of 2)");
      setBusy("Building the mint…");
      const mint = await buildMintTransaction(connection, input);
      setSignature(await submit(mint, prepared.setup ? "Minting (2 of 2)" : "Minting"));
    } catch (err) {
      setError(reportError("claim failed", err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-16 sm:px-5 sm:py-24">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance]">
          Claim a transfer yourself
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-bone/50">
          Circle&rsquo;s attestation for a burn is public, so anyone holding it can complete the
          mint — including you, and including transfers that are not yours. Use this when
          Circle&rsquo;s automatic delivery failed.
        </p>
      </header>

      <section>
        <label
          htmlFor="source"
          className="mb-2 block text-xs font-medium uppercase tracking-wider text-bone/40"
        >
          Burned on
        </label>
        <select
          id="source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setAttestation(null);
            setError(null);
          }}
          className="mb-5 w-full appearance-none rounded-tray bg-obsidian-sunken px-3 py-2.5 text-sm text-bone/80 ring-1 ring-inset ring-bone/10 transition-colors duration-200 focus:outline-none focus:ring-bone/30"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label
          htmlFor="tx"
          className="mb-2 block text-xs font-medium uppercase tracking-wider text-bone/40"
        >
          Burn transaction
        </label>
        <div className="flex gap-2">
          <input
            id="tx"
            spellCheck={false}
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
            placeholder={source === STELLAR ? "64 hex characters" : "0x and 64 hex characters"}
            className="tabular min-w-0 flex-1 rounded-tray bg-obsidian-sunken px-3 py-2.5 font-mono text-xs text-bone/80 ring-1 ring-inset ring-bone/10 transition-colors duration-200 placeholder:font-sans placeholder:text-bone/25 focus:outline-none focus:ring-bone/30"
          />
          <button
            type="button"
            onClick={lookUp}
            disabled={Boolean(busy) || !txHash.trim()}
            className="shrink-0 rounded-tray px-4 py-2.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Look up
          </button>
        </div>
      </section>

      {attestation?.status === "pending" && (
        <Notice tone="info" title="Circle has not signed this yet">
          Attestation usually lands within a few minutes of the burn, and can take about half an
          hour for a Standard transfer from some chains. Nothing is wrong and nothing is lost — try
          again shortly.
        </Notice>
      )}

      {attestation?.status === "unknown" && (
        <Notice tone="alarm" title="No CCTP transfer found">
          {attestation.reason ?? "Circle has no message for that transaction."}
        </Notice>
      )}

      {attestation?.status === "complete" && attestation.evm && (
        <EvmClaim
          // A fresh attestation is a different claim: nothing learned about the old one applies.
          key={attestation.attestation}
          message={attestation.message as `0x${string}`}
          attestation={attestation.attestation as `0x${string}`}
          target={attestation.evm}
          eventNonce={attestation.eventNonce ?? null}
          onReattested={() => setAttestation({ status: "pending" })}
        />
      )}

      {attestation?.status === "complete" &&
        !attestation.evm &&
        attestation.destinationDomain !== SOLANA_DOMAIN && (
          <Notice tone="alarm" title="This page cannot claim on that chain">
            Circle attested this transfer for a destination (CCTP domain{" "}
            {attestation.destinationDomain}) that this page does not submit to. The attestation is
            still valid and can be submitted with any CCTP tool.
          </Notice>
        )}

      {attestation?.status === "complete" && isSolanaBound(attestation) && alreadyMinted && (
        <Notice tone="signal" title="Already minted">
          Circle has already delivered this transfer — most likely its forwarding service got there
          first. Nothing is owed and there is nothing to claim.
        </Notice>
      )}

      {attestation?.status === "complete" &&
        isSolanaBound(attestation) &&
        !signature &&
        !alreadyMinted && (
          <>
            <Notice tone="signal" title="Attested and claimable">
              The funds are waiting. Submitting the mint costs you the Solana fee and about 0.0007
              SOL of account rent, which nobody can reclaim — this is the cost Circle&rsquo;s
              delivery fee normally covers. If the recipient has no USDC account yet, opening one is
              a separate wallet prompt first and about 0.0015 SOL more.
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
                    onClick={connect}
                    disabled={!provider}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:opacity-40"
                  >
                    {provider ? "Connect Phantom" : "Phantom not detected"}
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-bone/35">
                This wallet pays the gas. The USDC goes to whoever the burn named, which may be
                someone else entirely — that is how a stuck transfer can be rescued by a third
                party.
              </p>
            </section>

            {needsOwner && (
              <section>
                <Notice tone="info" title="Who receives this?" className="mb-2.5">
                  {needsOwner}. The address is checked against the burn before anything is signed.
                </Notice>
                <input
                  spellCheck={false}
                  value={recipientOwner}
                  onChange={(e) => setRecipientOwner(e.target.value)}
                  placeholder="Destination Solana wallet"
                  className="w-full rounded-tray bg-obsidian-sunken px-3 py-2.5 font-mono text-xs text-bone/80 ring-1 ring-inset ring-bone/10 transition-colors duration-200 placeholder:font-sans placeholder:text-bone/25 focus:outline-none focus:ring-bone/30"
                />
              </section>
            )}

            <button
              type="button"
              onClick={claim}
              disabled={!wallet || Boolean(busy)}
              className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
            >
              {busy ?? "Claim it"}
            </button>
          </>
        )}

      {error && (
        <Notice tone="alarm" title="That did not go through">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
            {error}
          </pre>
        </Notice>
      )}

      {signature && (
        <Notice tone="signal" title="Minted">
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
      )}
    </main>
  );
}
