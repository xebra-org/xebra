"use client";

import type { Transaction } from "@solana/web3.js";
import { EVM_CHAINS, evmChainForDomain } from "@xebra/sdk/core";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Notice } from "../../components/ui/notice";
import { browserConnection, buildMintTransaction, prepareClaim } from "../../lib/claim";
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

/** What Circle's service being down means to the person looking at the page. */
export const CIRCLE_UNAVAILABLE_MESSAGE =
  "Circle's service is not answering right now. Your transfer is not lost; try again in a few minutes.";

export type AttestationLookup =
  | { kind: "attestation"; attestation: Attestation }
  | { kind: "input-error"; message: string }
  | { kind: "circle-unavailable"; message: string }
  | { kind: "not-found"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Maps an attestation lookup response to what the page should show, so a server
 * failure is never mistaken for a wrong hash.
 *
 * - 400: the server rejected the request; its `error` is shown next to the input.
 * - 502/503: Circle is not answering; the transfer is not lost, only unreachable.
 * - 404: Circle has no message for that transaction; only this says "not found".
 * - 200: a complete or pending attestation passes through. An "unknown" one is
 *   Circle being unreachable when its reason says so ("Circle returned 500",
 *   "lookups are paused"), and a real not-found otherwise.
 */
export function mapAttestationResponse(status: number, body: unknown): AttestationLookup {
  if (status === 400) {
    const message = isRecord(body) ? body.error : undefined;
    return {
      kind: "input-error",
      message:
        typeof message === "string" && message.length > 0
          ? message
          : "That request was not understood. Check the transaction hash and try again.",
    };
  }
  if (status === 502 || status === 503) {
    return { kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE };
  }
  if (status === 404) {
    return { kind: "not-found", reason: "Circle has no message for that transaction." };
  }
  if (status !== 200) {
    return { kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE };
  }
  const attestation = body as Attestation | null;
  if (attestation?.status === "complete" || attestation?.status === "pending") {
    return { kind: "attestation", attestation };
  }
  if (attestation?.status === "unknown") {
    const reason = attestation.reason ?? "";
    if (/circle returned \d+/i.test(reason) || /paused/i.test(reason)) {
      return { kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE };
    }
    return {
      kind: "not-found",
      reason: reason || "Circle has no message for that transaction.",
    };
  }
  return { kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE };
}

const STELLAR_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
/** A Sui transaction digest: base58, so it is never lower-cased. */
const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
/** Solana's CCTP domain. The one destination claimed with a Solana wallet instead of an EVM one. */
const SOLANA_DOMAIN = 5;

/** Where the burn was made: "stellar", or an EVM chain's CCTP domain as a string. */
type Source = string;
const STELLAR: Source = "stellar";
/** Sui's CCTP domain. A Sui burn to an EVM chain is claimed there like any EVM-bound one. */
const SUI: Source = "8";
/**
 * Solana as the chain burned on (domain 5, as a source). A Solana burn to an EVM chain is claimed
 * there like any EVM-bound one; its transaction is a base58 signature, never lower-cased.
 */
const SOLANA: Source = "5";
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** Aptos's CCTP domain. Its hashes are 0x and 64 hex, read like an EVM chain's. */
const APTOS: Source = "9";

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: STELLAR, label: "Stellar" },
  { value: SUI, label: "Sui" },
  { value: SOLANA, label: "Solana" },
  { value: APTOS, label: "Aptos" },
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
  /** A 400 from the lookup: the server's error, shown next to the input. */
  const [inputError, setInputError] = useState<string | null>(null);
  /** Circle not answering: a 502/503, or a lookup that timed out. */
  const [circleUnavailable, setCircleUnavailable] = useState<string | null>(null);
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
    const raw = params.get("tx")?.trim();
    const fromLink = raw?.toLowerCase();
    const src = params.get("src");
    if (src === SUI) {
      setSource(SUI);
      if (raw && SUI_DIGEST.test(raw)) setTxHash(raw);
      return;
    }
    if (src === SOLANA) {
      setSource(SOLANA);
      if (raw && SOLANA_SIGNATURE.test(raw)) setTxHash(raw);
      return;
    }
    if (src === APTOS) {
      setSource(APTOS);
      if (fromLink && EVM_HASH.test(fromLink)) setTxHash(fromLink);
      return;
    }
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
    const onSui = source === SUI;
    const onSolana = source === SOLANA;
    const hash = onSui || onSolana ? txHash.trim() : txHash.trim().toLowerCase();
    const onStellar = source === STELLAR;
    if (onSui && !SUI_DIGEST.test(hash)) {
      setError("That is not a Sui transaction digest. Copy it from your wallet or a Sui explorer.");
      return;
    }
    if (onSolana && !SOLANA_SIGNATURE.test(hash)) {
      setError("That is not a Solana transaction signature. Copy it from your wallet or Solscan.");
      return;
    }
    if (!onSui && !onSolana && !(onStellar ? STELLAR_HASH : EVM_HASH).test(hash)) {
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
    setInputError(null);
    setCircleUnavailable(null);
    setNeedsOwner(null);
    setAlreadyMinted(false);
    try {
      const query = new URLSearchParams({ tx: hash });
      if (!onStellar) query.set("src", source);
      const res = await fetch(`/api/attestation?${query}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const outcome = mapAttestationResponse(res.status, await res.json().catch(() => null));
      switch (outcome.kind) {
        case "attestation":
          setAttestation(outcome.attestation);
          break;
        case "input-error":
          setInputError(outcome.message);
          break;
        case "circle-unavailable":
          setCircleUnavailable(outcome.message);
          break;
        case "not-found":
          setAttestation({ status: "unknown", reason: outcome.reason });
          break;
      }
    } catch (err) {
      // A lookup that times out is Circle not answering, not a wrong hash.
      if (err instanceof DOMException && err.name === "TimeoutError") {
        setCircleUnavailable(CIRCLE_UNAVAILABLE_MESSAGE);
      } else {
        setError(reportError("could not reach Circle", err));
      }
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
            setInputError(null);
            setCircleUnavailable(null);
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
            onChange={(e) => {
              setTxHash(e.target.value);
              setInputError(null);
              setCircleUnavailable(null);
            }}
            placeholder={
              source === STELLAR
                ? "64 hex characters"
                : source === SUI
                  ? "Sui transaction digest"
                  : source === SOLANA
                    ? "Solana transaction signature"
                    : "0x and 64 hex characters"
            }
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
        {inputError && (
          <p role="alert" className="mt-2 text-xs leading-relaxed text-alarm">
            {inputError}
          </p>
        )}
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

      {circleUnavailable && (
        <Notice tone="info" title="Circle is not answering right now">
          {circleUnavailable}
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
