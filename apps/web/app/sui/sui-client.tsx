"use client";

import type { EvmChainId } from "@xebra/sdk/core";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { CHAIN_NAMES } from "../../components/bridge/chain-glyph";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { Field, Input } from "../../components/ui/field";
import { GlassCard, InsetTray } from "../../components/ui/glass-card";
import { ArrowRight, Check } from "../../components/ui/icons";
import { Notice } from "../../components/ui/notice";
import { useWallets } from "../../components/wallet/wallet-provider";
import { reportError } from "../../lib/format-error";
import { claimOnStellar } from "../../lib/sui-stellar/claim-client";
import { signAndExecuteSui } from "../../lib/wallets/sui";
import { type SuiDestination, SuiDestinationPicker, SuiForwarded, recallSuiEvm } from "./sui-evm";

/**
 * Sui to Stellar: connect a Sui wallet, burn USDC, and watch it arrive.
 *
 * The server builds the burn and the wallet signs it, so no key ever leaves the wallet. After the
 * burn, Circle attests it and the relayer completes the mint on Stellar. The digest is kept in
 * this browser (and can be put in the address as `?tx=`) so closing the tab does not lose track of
 * a transfer that is still on its way.
 */

const STORAGE_KEY = "xebra.sui-stellar.digest";
const POLL_MS = 4000;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export type Delivery =
  | { kind: "idle" }
  | { kind: "completing" }
  | { kind: "done"; hash: string | null }
  | { kind: "stuck"; message: string };

export type Attest = "unknown" | "pending" | "complete";

function remember(digest: string | null) {
  try {
    if (digest) window.localStorage.setItem(STORAGE_KEY, digest);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the transfer still works, it just cannot be resumed.
  }
}

function recall(): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && DIGEST.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Whether a Sui transfer is in the address (`?tx=`) or was being followed in this browser. */
export function hasRememberedSuiTransfer(): boolean {
  const fromUrl = new URLSearchParams(window.location.search).get("tx")?.trim() ?? "";
  return DIGEST.test(fromUrl) || recall() !== null || recallSuiEvm() !== null;
}

const short = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;

type Problem = { text: string; declined: boolean };

// Wallets word a declined request differently ("User rejected the request", "Cancelled", ...).
const DECLINED = /reject|declin|den(y|ied)|cancel|closed|dismiss/i;

function problem(label: string, err: unknown): Problem {
  const text = reportError(label, err);
  return { text, declined: DECLINED.test(text) };
}

/** The standalone `/sui` page: a heading around the same transfer the bridge screen embeds. */
export function SuiClient({
  maxUsdc,
  relayerEnabled,
  evmDestinations = [],
  solana = false,
}: {
  maxUsdc: string | null;
  relayerEnabled: boolean;
  evmDestinations?: EvmChainId[];
  /** Sui also sends to Solana (`SUI_SENDS_TO_SOLANA`). */
  solana?: boolean;
}) {
  const others = [...evmDestinations, ...(solana ? (["solana"] as const) : [])];
  const where =
    others.length === 0
      ? "Stellar"
      : others.length <= 2
        ? `Stellar or ${others.map((id) => CHAIN_NAMES[id]).join(" or ")}`
        : "Stellar or the chain you choose";
  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-14 sm:px-5 sm:py-20">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance]">
          {others.length === 0 ? "Send USDC from Sui to Stellar" : "Send USDC from Sui"}
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-bone/50">
          Burn native USDC on Sui with Circle&rsquo;s CCTP and it is minted on {where} to the
          address you choose. No wrapped tokens, and Xebra never holds your funds.
        </p>
      </header>

      <Notice tone="info" title="Pilot on mainnet">
        Real USDC{maxUsdc !== null ? `, up to ${maxUsdc} per transfer` : ""}. Check the recipient
        address twice: the mint goes only to the address you enter, and a burn cannot be undone.
      </Notice>

      <SuiTransfer
        maxUsdc={maxUsdc}
        relayerEnabled={relayerEnabled}
        evmDestinations={evmDestinations}
        solana={solana}
      />
    </main>
  );
}

/**
 * The whole transfer: connect a Sui wallet, burn, watch Circle attest it, and see the mint land on
 * Stellar. Used standalone on `/sui` and, with `embedded`, inside the plate on the bridge screen,
 * where the plate is the card and `sourcePicker` is the "Send from" row.
 */
export function SuiTransfer({
  maxUsdc,
  relayerEnabled,
  evmDestinations = [],
  solana = false,
  embedded = false,
  sourcePicker,
  onBusyChange,
}: {
  maxUsdc: string | null;
  relayerEnabled: boolean;
  /** EVM chains the server lets Sui send to, delivered by Circle's Forwarding Service. */
  evmDestinations?: EvmChainId[];
  /** Sui also sends to Solana, delivered the same way. */
  solana?: boolean;
  embedded?: boolean;
  sourcePicker?: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<"idle" | "preparing" | "signing">("idle");
  const [error, setError] = useState<Problem | null>(null);
  const [to, setTo] = useState<SuiDestination>("stellar");
  const forwardedKey = [...evmDestinations, ...(solana ? ["solana"] : [])].join(",");

  const [digest, setDigest] = useState<string | null>(null);
  const [attest, setAttest] = useState<Attest>("unknown");
  const [delivery, setDelivery] = useState<Delivery>({ kind: "idle" });

  // The Sui wallet is the one connected in the wallet modal, the same connection the top bar shows.
  // Finishing the mint yourself needs a Stellar wallet that can pay the fee.
  const {
    connections,
    stellarKit,
    sui: signer,
    open: openWallets,
    disconnect: disconnectWallet,
  } = useWallets();
  const wallet = signer?.wallet ?? null;
  const account = signer?.account ?? null;
  const stellarAddress = connections.stellar?.address ?? null;
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [recipientSeen, setRecipientSeen] = useState<string | null>(null);

  // Changing the source chain on the bridge screen is blocked while a transfer is on screen.
  // On an EVM destination `SuiToEvm` reports instead.
  useEffect(() => {
    if (to !== "stellar") return;
    onBusyChange?.(step !== "idle" || (digest !== null && delivery.kind !== "done"));
  }, [onBusyChange, to, step, digest, delivery.kind]);

  // A transfer already under way: from the address bar, else from this browser.
  useEffect(() => {
    // Read from the address after mounting rather than through `useSearchParams`, which would make
    // the bridge screen this is embedded in client-rendered only.
    const fromUrl = new URLSearchParams(window.location.search).get("tx")?.trim() ?? "";
    if (DIGEST.test(fromUrl)) {
      setDigest(fromUrl);
      return;
    }
    // A transfer to an EVM chain or Solana is followed by `SuiForwarded`, which reads its own record.
    const forwarded = recallSuiEvm();
    if (forwarded && forwardedKey.split(",").includes(forwarded.chain)) {
      setTo(forwarded.chain);
      return;
    }
    const start = recall();
    if (start) setDigest(start);
  }, [forwardedKey]);

  const amountOk = /^\d{1,12}(\.\d{1,6})?$/.test(amount.trim()) && Number(amount) > 0;
  const recipientOk = /^G[A-Z2-7]{55}$/.test(recipient.trim());
  const canSend = Boolean(wallet && account) && amountOk && recipientOk && step === "idle";

  async function send() {
    if (!wallet || !account) return;
    setError(null);
    setStep("preparing");
    try {
      const res = await fetch("/api/sui-stellar/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender: account.address,
          amount: amount.trim(),
          recipient: recipient.trim(),
        }),
      });
      const body = (await res.json()) as { transaction?: string; error?: string };
      if (!res.ok || !body.transaction) {
        setError({ text: body.error ?? "Could not prepare the transfer.", declined: false });
        return;
      }
      setStep("signing");
      const tx = await signAndExecuteSui(wallet, account, body.transaction);
      remember(tx);
      setAttest("unknown");
      setDelivery({ kind: "idle" });
      setDigest(tx);
    } catch (err) {
      setError(problem("sui burn failed", err));
    } finally {
      setStep("idle");
    }
  }

  // Follow a burn: ask Circle until it attests, then ask the relayer to finish the mint.
  const completing = useRef(false);
  useEffect(() => {
    if (!digest || delivery.kind === "done" || delivery.kind === "stuck") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const s = await fetch(`/api/sui-stellar/status?digest=${digest}`, { cache: "no-store" });
        const body = (await s.json()) as {
          state?: Attest;
          delivered?: boolean;
          recipient?: string;
        };
        const state: Attest = body.state ?? "unknown";
        if (cancelled) return;
        setAttest(state);
        if (body.recipient) setRecipientSeen(body.recipient);

        // Already minted, by the relayer, by hand, or from another browser: nothing left to do.
        if (state === "complete" && body.delivered) {
          setDelivery({ kind: "done", hash: null });
          remember(null);
          return;
        }

        if (state === "complete" && relayerEnabled && !completing.current) {
          completing.current = true;
          setDelivery({ kind: "completing" });
          const c = await fetch("/api/sui-stellar/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ digest }),
          });
          const result = (await c.json()) as {
            status?: string;
            hash?: string;
            reason?: string;
          };
          completing.current = false;
          if (cancelled) return;
          if (result.status === "delivered") {
            setDelivery({ kind: "done", hash: null });
            remember(null);
            return;
          }
          if (result.status === "submitted" && result.hash) {
            setDelivery({ kind: "done", hash: result.hash });
            remember(null);
            return;
          }
          if (result.status === "refused" || result.status === "failed") {
            setDelivery({
              kind: "stuck",
              message: result.reason ?? "The mint could not be completed.",
            });
            return;
          }
          setDelivery({ kind: "idle" });
        }
      } catch {
        completing.current = false;
        // A dropped request is not a failed transfer; the next tick asks again.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [digest, delivery.kind, relayerEnabled]);

  function startOver() {
    remember(null);
    completing.current = false;
    setDigest(null);
    setAttest("unknown");
    setDelivery({ kind: "idle" });
    setError(null);
    setClaimError(null);
    setRecipientSeen(null);
  }

  async function claim() {
    if (!digest || !stellarKit || !stellarAddress) return;
    setClaimError(null);
    setClaiming(true);
    try {
      const r = await claimOnStellar(stellarKit, stellarAddress, digest);
      setDelivery({ kind: "done", hash: r.delivered ? null : r.hash });
      remember(null);
    } catch (err) {
      setClaimError(reportError("sui claim on stellar failed", err));
    } finally {
      setClaiming(false);
    }
  }

  const progress = digest ? (
    <Progress
      digest={digest}
      attest={attest}
      delivery={delivery}
      relayerEnabled={relayerEnabled}
      recipient={recipientSeen}
      stellarAddress={stellarAddress}
      claiming={claiming}
      claimError={claimError}
      onClaim={claim}
      onConnectStellar={() => openWallets(["stellar"])}
      onRetry={() => setDelivery({ kind: "idle" })}
      onReset={startOver}
    />
  ) : null;

  const burnLabel =
    step === "preparing"
      ? "Preparing"
      : step === "signing"
        ? "Confirm in your wallet"
        : "Burn on Sui";

  const walletSection = (
    <WalletSection
      address={account?.address ?? null}
      walletName={wallet?.name ?? null}
      onConnect={() => openWallets(["sui"])}
      onDisconnect={() => void disconnectWallet("sui")}
    />
  );

  const destinations: SuiDestination[] = [
    "stellar",
    ...evmDestinations,
    ...(solana ? (["solana"] as const) : []),
  ];
  const picker =
    destinations.length > 1 ? (
      <SuiDestinationPicker
        value={to}
        options={destinations}
        onChange={(d) => {
          setError(null);
          setTo(d);
        }}
        disabled={step !== "idle"}
      />
    ) : null;

  const form = (
    <div className="flex flex-col gap-6">
      {walletSection}
      {picker}

      <Field
        id="sui-amount"
        label="Amount"
        hint={maxUsdc !== null ? `USDC on Sui. Up to ${maxUsdc} per transfer.` : "USDC on Sui."}
        trailing={<span className="text-xs text-bone/35">USDC</span>}
      >
        <Input
          id="sui-amount"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="tabular h-12 text-base"
          invalid={amount.trim() !== "" && !amountOk}
        />
      </Field>

      <Field
        id="sui-recipient"
        label="Stellar address"
        hint="An existing account that already holds a USDC trustline. Starts with G."
        error={
          recipient.trim() !== "" && !recipientOk ? "That is not a Stellar account address." : null
        }
      >
        <Input
          id="sui-recipient"
          autoComplete="off"
          spellCheck={false}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="G..."
          className="h-12 font-mono text-xs"
          invalid={recipient.trim() !== "" && !recipientOk}
        />
      </Field>

      {error && <ProblemNotice problem={error} />}

      <Button
        size="lg"
        disabled={!canSend}
        onClick={send}
        trailing={<ArrowRight className="h-4 w-4" />}
      >
        {burnLabel}
      </Button>
    </div>
  );

  const body =
    to === "stellar" ? null : (
      <SuiForwarded
        to={to}
        signer={signer}
        maxUsdc={maxUsdc}
        walletSection={walletSection}
        picker={picker}
        {...(onBusyChange ? { onBusyChange } : {})}
      />
    );

  if (embedded) {
    return (
      <>
        <h2 id="bridge-heading" className="sr-only">
          Bridge USDC from Sui to {CHAIN_NAMES[to]}
        </h2>
        <div className="px-5 py-6 sm:px-6">
          {sourcePicker}
          <Notice tone="info" title="Pilot on mainnet" className="mb-6">
            Real USDC{maxUsdc !== null ? `, up to ${maxUsdc} per transfer` : ""}. Check the
            recipient address twice: the mint goes only to the address you enter, and a burn cannot
            be undone.
          </Notice>
          {body ?? progress ?? form}
        </div>
      </>
    );
  }

  if (body) {
    return (
      <GlassCard labelledBy="sui-form-title" spotlight={false}>
        <div className="p-5 sm:p-6">
          <h2 id="sui-form-title" className="sr-only">
            Transfer details
          </h2>
          {body}
        </div>
      </GlassCard>
    );
  }

  return (
    <>
      {progress ? (
        <GlassCard labelledBy="sui-progress-title" spotlight={false}>
          <div className="p-5 sm:p-6">{progress}</div>
        </GlassCard>
      ) : (
        <GlassCard labelledBy="sui-form-title" spotlight={false}>
          <div className="p-5 sm:p-6">
            <h2 id="sui-form-title" className="sr-only">
              Transfer details
            </h2>
            {form}
          </div>
        </GlassCard>
      )}
    </>
  );
}

function ProblemNotice({ problem }: { problem: Problem }) {
  if (problem.declined) {
    return (
      <Notice tone="info" title="Wallet request cancelled">
        The wallet reported: {problem.text} If you did not cancel it yourself, the wallet window may
        have been blocked or closed. Allow pop-ups for this site, then try again.
      </Notice>
    );
  }
  return (
    <Notice tone="alarm" title="Could not send">
      {problem.text}
    </Notice>
  );
}

/**
 * The Sui wallet, as the wallet modal connected it: one place to connect, the same connection the
 * top bar shows. Connecting opens the modal on its Sui tab, which lists every Sui wallet the browser
 * has (through the Wallet Standard) and says so when there is none.
 */
function WalletSection({
  address,
  walletName,
  onConnect,
  onDisconnect,
}: {
  address: string | null;
  walletName: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (address) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-eyebrow font-medium uppercase text-bone/40">Sui wallet</p>
          <p className="mt-1.5 text-sm text-bone/85">
            {walletName} <span className="font-mono text-xs text-bone/50">{short(address)}</span>
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-2.5 text-eyebrow font-medium uppercase text-bone/40">Sui wallet</p>
      <Button variant="secondary" onClick={onConnect} className="w-full">
        Connect a Sui wallet
      </Button>
    </div>
  );
}

/**
 * A burn into Stellar on its way: burned, attested, minted. Shared with transfers that start on
 * Solana (`components/bridge/solana-bridge-form.tsx`) and Aptos
 * (`components/bridge/aptos-bridge-form.tsx`), which name their own chain and explorer.
 */
export function Progress({
  digest,
  sourceName = "Sui",
  burnUrl,
  attest,
  delivery,
  relayerEnabled,
  recipient,
  stellarAddress,
  claiming,
  claimError,
  onClaim,
  onConnectStellar,
  onRetry,
  onReset,
}: {
  digest: string;
  sourceName?: string;
  /** Where the burn is shown; Suivision for a Sui digest when omitted. */
  burnUrl?: string;
  attest: Attest;
  delivery: Delivery;
  relayerEnabled: boolean;
  recipient: string | null;
  stellarAddress: string | null;
  claiming: boolean;
  claimError: string | null;
  onClaim: () => void;
  onConnectStellar: () => void;
  onRetry: () => void;
  onReset: () => void;
}) {
  const attested = attest === "complete";
  const done = delivery.kind === "done";
  // The relayer finishes the mint by itself. Without one, or when it gave up, the person who sent
  // it can finish it from their own Stellar wallet and pay the fee.
  const canClaim = attested && !done && (!relayerEnabled || delivery.kind === "stuck");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="sui-progress-title" className="text-sm font-semibold text-bone/85">
          {done ? "Delivered" : "On its way"}
        </h2>
        <Badge tone={done ? "signal" : "neutral"}>{done ? "Complete" : "In progress"}</Badge>
      </div>

      <InsetTray>
        <ol className="flex flex-col gap-4">
          <Row
            state="done"
            title={`Burned on ${sourceName}`}
            detail={
              <a
                className="font-mono text-xs underline decoration-bone/20 underline-offset-4 hover:decoration-bone/60"
                href={burnUrl ?? `https://suivision.xyz/txblock/${digest}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(digest)}
              </a>
            }
          />
          <Row
            state={attested ? "done" : "active"}
            title="Attested by Circle"
            detail={
              attested ? undefined : (
                <span className="text-xs text-bone/40">
                  Usually a minute or two. This page keeps checking.
                </span>
              )
            }
          />
          <Row
            state={done ? "done" : attested ? "active" : "waiting"}
            title="Minted on Stellar"
            detail={
              delivery.kind === "done" && delivery.hash ? (
                <a
                  className="font-mono text-xs underline decoration-bone/20 underline-offset-4 hover:decoration-bone/60"
                  href={`https://stellar.expert/explorer/public/tx/${delivery.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(delivery.hash)}
                </a>
              ) : recipient ? (
                <span className="font-mono text-xs text-bone/40">to {short(recipient)}</span>
              ) : undefined
            }
          />
        </ol>
      </InsetTray>

      {delivery.kind === "stuck" && (
        <Notice tone="alarm" title="The mint did not complete">
          {delivery.message} Your USDC is not lost. Circle&rsquo;s attestation is public, so the
          mint can still be completed, and the same digest can be tried again.
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </Notice>
      )}

      {canClaim && (
        <Notice tone="info" title="Claim it on Stellar">
          Circle has attested the burn, so the USDC is ready to mint
          {recipient ? ` to ${short(recipient)}` : ""}. Finish it from your own Stellar wallet: you
          sign once and pay the network fee, a few hundredths of an XLM. Any Stellar wallet will do,
          it does not have to be the recipient&rsquo;s.
          {claimError && <p className="mt-3 text-bone/70">{claimError}</p>}
          <div className="mt-3">
            {stellarAddress ? (
              <Button variant="primary" size="sm" disabled={claiming} onClick={onClaim}>
                {claiming ? "Confirm in your wallet" : "Claim on Stellar"}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onConnectStellar}>
                Connect a Stellar wallet
              </Button>
            )}
          </div>
        </Notice>
      )}

      {done && (
        <Notice tone="signal" title="USDC minted on Stellar">
          The recipient now holds the USDC.
          {delivery.hash ? " The links above show both sides on public explorers." : ""}
        </Notice>
      )}

      <div className={cn("flex", done ? "justify-end" : "justify-between")}>
        {!done && (
          <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
            Safe to close this tab. Come back to this page on the same browser and it picks up where
            it left off.
          </p>
        )}
        <Button variant={done ? "primary" : "quiet"} size="sm" onClick={onReset}>
          {done ? "Send another" : "Start over"}
        </Button>
      </div>
    </div>
  );
}

function Row({
  state,
  title,
  detail,
}: {
  state: "done" | "active" | "waiting";
  title: string;
  detail?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
          state === "done" && "bg-signal/15 text-signal ring-signal/30",
          state === "active" && "text-bone/70 ring-bone/25 motion-safe:animate-pulse",
          state === "waiting" && "text-bone/25 ring-bone/10",
        )}
      >
        {state === "done" ? <Check className="h-3 w-3" /> : null}
      </span>
      <div className="min-w-0">
        <p className={cn("text-sm", state === "waiting" ? "text-bone/40" : "text-bone/85")}>
          {title}
        </p>
        {detail && <div className="mt-1">{detail}</div>}
      </div>
    </li>
  );
}
