"use client";

import type { WalletAccount } from "@wallet-standard/base";
import { useSearchParams } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { Field, Input } from "../../components/ui/field";
import { GlassCard, InsetTray } from "../../components/ui/glass-card";
import { ArrowRight, Check } from "../../components/ui/icons";
import { Notice } from "../../components/ui/notice";
import { reportError } from "../../lib/format-error";
import {
  type SuiWalletEntry,
  connectSui,
  signAndExecuteSui,
  watchSuiWallets,
} from "../../lib/wallets/sui";

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

type Delivery =
  | { kind: "idle" }
  | { kind: "completing" }
  | { kind: "done"; hash: string }
  | { kind: "stuck"; message: string };

type Attest = "unknown" | "pending" | "complete";

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

const short = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;

export function SuiClient({
  maxUsdc,
  relayerEnabled,
}: {
  maxUsdc: string;
  relayerEnabled: boolean;
}) {
  const params = useSearchParams();
  const [wallets, setWallets] = useState<SuiWalletEntry[]>([]);
  const [wallet, setWallet] = useState<SuiWalletEntry | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<"idle" | "preparing" | "signing">("idle");
  const [error, setError] = useState<string | null>(null);

  const [digest, setDigest] = useState<string | null>(null);
  const [attest, setAttest] = useState<Attest>("unknown");
  const [delivery, setDelivery] = useState<Delivery>({ kind: "idle" });

  useEffect(() => watchSuiWallets(setWallets), []);

  // A transfer already under way: from the address bar, else from this browser.
  useEffect(() => {
    const fromUrl = params.get("tx")?.trim() ?? "";
    const start = DIGEST.test(fromUrl) ? fromUrl : recall();
    if (start) setDigest(start);
  }, [params]);

  const connect = useCallback(async (entry: SuiWalletEntry) => {
    setError(null);
    try {
      const acc = await connectSui(entry);
      setWallet(entry);
      setAccount(acc);
    } catch (err) {
      setError(reportError("sui wallet connect failed", err));
    }
  }, []);

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
        setError(body.error ?? "Could not prepare the transfer.");
        return;
      }
      setStep("signing");
      const tx = await signAndExecuteSui(wallet, account, body.transaction);
      remember(tx);
      setAttest("unknown");
      setDelivery({ kind: "idle" });
      setDigest(tx);
    } catch (err) {
      setError(reportError("sui burn failed", err));
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
        const body = (await s.json()) as { state?: Attest };
        const state: Attest = body.state ?? "unknown";
        if (cancelled) return;
        setAttest(state);

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
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-14 sm:px-5 sm:py-20">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance]">
          Send USDC from Sui to Stellar
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-bone/50">
          Burn native USDC on Sui with Circle&rsquo;s CCTP and it is minted on Stellar to the
          address you choose. No wrapped tokens, and Xebra never holds your funds.
        </p>
      </header>

      <Notice tone="info" title="Pilot on mainnet">
        Real USDC, up to {maxUsdc} per transfer. Check the Stellar address twice: the mint goes only
        to the address you enter, and a burn cannot be undone.
      </Notice>

      {digest ? (
        <Progress
          digest={digest}
          attest={attest}
          delivery={delivery}
          relayerEnabled={relayerEnabled}
          onRetry={() => setDelivery({ kind: "idle" })}
          onReset={startOver}
        />
      ) : (
        <GlassCard labelledBy="sui-form-title" spotlight={false}>
          <div className="flex flex-col gap-6 p-5 sm:p-6">
            <h2 id="sui-form-title" className="sr-only">
              Transfer details
            </h2>

            <WalletSection
              wallets={wallets}
              account={account}
              walletName={wallet?.name ?? null}
              onConnect={connect}
              onDisconnect={() => {
                setWallet(null);
                setAccount(null);
              }}
            />

            <Field
              id="sui-amount"
              label="Amount"
              hint={`USDC on Sui. Up to ${maxUsdc} while this is a pilot.`}
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
                recipient.trim() !== "" && !recipientOk
                  ? "That is not a Stellar account address."
                  : null
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

            {error && (
              <Notice tone="alarm" title="Could not send">
                {error}
              </Notice>
            )}

            <Button
              size="lg"
              disabled={!canSend}
              onClick={send}
              trailing={<ArrowRight className="h-4 w-4" />}
            >
              {step === "preparing"
                ? "Preparing"
                : step === "signing"
                  ? "Confirm in your wallet"
                  : "Burn on Sui"}
            </Button>
          </div>
        </GlassCard>
      )}

      {!relayerEnabled && (
        <Notice tone="info" title="Completion is switched off here">
          You can burn, but nothing finishes the mint on Stellar for you in this deployment. Keep
          your transaction digest.
        </Notice>
      )}
    </main>
  );
}

function WalletSection({
  wallets,
  account,
  walletName,
  onConnect,
  onDisconnect,
}: {
  wallets: SuiWalletEntry[];
  account: WalletAccount | null;
  walletName: string | null;
  onConnect: (w: SuiWalletEntry) => void;
  onDisconnect: () => void;
}) {
  if (account) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-eyebrow font-medium uppercase text-bone/40">Sui wallet</p>
          <p className="mt-1.5 text-sm text-bone/85">
            {walletName}{" "}
            <span className="font-mono text-xs text-bone/50">{short(account.address)}</span>
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }
  if (wallets.length === 0) {
    return (
      <Notice tone="info" title="No Sui wallet found">
        Install or unlock a Sui wallet in this browser, then reload the page. Any wallet that
        supports the Wallet Standard will appear here.
      </Notice>
    );
  }
  return (
    <div>
      <p className="mb-2.5 text-eyebrow font-medium uppercase text-bone/40">Connect a Sui wallet</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {wallets.map((w) => (
          <Button
            key={w.name}
            variant="secondary"
            onClick={() => onConnect(w)}
            className="justify-start"
          >
            {w.icon && <img src={w.icon} alt="" className="h-5 w-5 rounded-md" />}
            {w.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Progress({
  digest,
  attest,
  delivery,
  relayerEnabled,
  onRetry,
  onReset,
}: {
  digest: string;
  attest: Attest;
  delivery: Delivery;
  relayerEnabled: boolean;
  onRetry: () => void;
  onReset: () => void;
}) {
  const attested = attest === "complete";
  const done = delivery.kind === "done";
  return (
    <GlassCard labelledBy="sui-progress-title" spotlight={false}>
      <div className="flex flex-col gap-5 p-5 sm:p-6">
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
              title="Burned on Sui"
              detail={
                <a
                  className="font-mono text-xs underline decoration-bone/20 underline-offset-4 hover:decoration-bone/60"
                  href={`https://suivision.xyz/txblock/${digest}`}
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
              state={done ? "done" : attested && relayerEnabled ? "active" : "waiting"}
              title="Minted on Stellar"
              detail={
                delivery.kind === "done" ? (
                  <a
                    className="font-mono text-xs underline decoration-bone/20 underline-offset-4 hover:decoration-bone/60"
                    href={`https://stellar.expert/explorer/public/tx/${delivery.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(delivery.hash)}
                  </a>
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

        {!relayerEnabled && attested && (
          <Notice tone="info" title="Attested and waiting">
            Circle has attested the burn. Completion is not switched on in this deployment, so keep
            the digest above until it is.
          </Notice>
        )}

        {done && (
          <Notice tone="signal" title="USDC minted on Stellar">
            The recipient now holds the USDC. The links above show both sides on public explorers.
          </Notice>
        )}

        <div className={cn("flex", done ? "justify-end" : "justify-between")}>
          {!done && (
            <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
              Safe to close this tab. Come back to this page on the same browser and it picks up
              where it left off.
            </p>
          )}
          <Button variant={done ? "primary" : "quiet"} size="sm" onClick={onReset}>
            {done ? "Send another" : "Start over"}
          </Button>
        </div>
      </div>
    </GlassCard>
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
