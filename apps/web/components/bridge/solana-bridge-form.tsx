"use client";

import { Connection } from "@solana/web3.js";
import type { CircleHealth } from "@xebra/cctp-client";
import {
  EVM_CHAINS,
  type EvmChainId,
  type FeePlan,
  checkAddressOn,
  explorerTxUrl,
  formatUsdc6,
  isEvmChainId,
  planEvmFee,
} from "@xebra/sdk/core";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Attest, type Delivery, Progress } from "../../app/sui/sui-client";
import { type DeliveryView, getDelivery, getRouteHealth } from "../../lib/circle-status";
import { reportError } from "../../lib/format-error";
import { waitForSignature } from "../../lib/solana-confirm";
import { claimOnStellar } from "../../lib/sui-stellar/claim-client";
import { Button } from "../ui/button";
import { DataRow } from "../ui/data-row";
import { Field, Input } from "../ui/field";
import { InsetTray } from "../ui/glass-card";
import { ArrowRight } from "../ui/icons";
import { Notice } from "../ui/notice";
import { StripeRule } from "../ui/stripe-rule";
import { useWallets } from "../wallet/wallet-provider";
import type { Chain } from "./chain-glyph";
import { ChainPicker, PickerLabel } from "./chain-picker";
import { EvmQuotePanel } from "./evm-quote-panel";
import { SubmittedNotice } from "./receipt";

/**
 * A transfer that starts on Solana: burn native USDC there with the connected Solana wallet, and
 * it is minted on an EVM chain (delivered by Circle's Forwarding Service) or on Stellar (completed
 * by our relayer, or by the owner from their own Stellar wallet).
 *
 * The server builds the burn (`/api/solana-source/build`), simulated and co-signed by a one-time
 * event-account key; the wallet adds the only signature it is missing. Xebra takes no fee here:
 * there is no Xebra contract on Solana, so the person pays Circle's delivery fee and Solana's own
 * network costs, and nothing else.
 *
 * Which destinations exist is the server's `SOLANA_SENDS_TO`, read through `/api/solana-source/config`.
 */

const SOLANA_DOMAIN = 5;
const STORAGE_KEY = "xebra.solana-source.transfer";
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const POLL_MS = 5000;
const HEALTH_MS = 30_000;
/** As in `sui-evm.tsx`: Iris can show the attestation a moment before the delivery under way. */
const CLAIM_GRACE_MS = 10 * 60_000;
/** Measured on mainnet: the burn's message account (about 0.003 SOL) and the network fee. */
const SOL_COST = "about 0.0035 SOL";

export type SolanaDestination = "stellar" | EvmChainId;

export interface SolanaSourceConfig {
  evm: EvmChainId[];
  stellar: boolean;
  relayer: boolean;
  maxUsdc: string | null;
  stellarMinUsdc: string;
}

interface Remembered {
  tx: string;
  to: SolanaDestination;
  at: number;
}

function remember(t: Remembered | null) {
  try {
    if (t) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the transfer still works, it just cannot be resumed.
  }
}

/** The Solana transfer this browser was following, if any. */
export function recallSolanaTransfer(): Remembered | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    const to = v.to;
    return typeof v.tx === "string" &&
      SIGNATURE.test(v.tx) &&
      typeof to === "string" &&
      (to === "stellar" || isEvmChainId(to))
      ? { tx: v.tx, to, at: typeof v.at === "number" ? v.at : 0 }
      : null;
  } catch {
    return null;
  }
}

function parseAmount(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const v = BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return v > 0n ? v : null;
}

const short = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;
const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
const nameOf = (d: SolanaDestination) => (d === "stellar" ? "Stellar" : EVM_CHAINS[d].name);

/** The browser reaches Solana through our proxy: the public RPC refuses browser origins. */
function proxyConnection(): Connection {
  return new Connection(new URL("/api/solana-rpc", window.location.origin).toString(), {
    commitment: "confirmed",
  });
}

export function SolanaBridgeForm({
  config,
  sourcePicker,
  onBusyChange,
}: {
  config: SolanaSourceConfig;
  sourcePicker?: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { connections, stellarKit, open: openWallets, disconnect, sendSolana } = useWallets();
  const solana = connections.solana ?? null;
  const stellarAddress = connections.stellar?.address ?? null;

  const destinations = useMemo<SolanaDestination[]>(
    () => [...(config.stellar ? (["stellar"] as const) : []), ...config.evm],
    [config.stellar, config.evm],
  );
  const [to, setTo] = useState<SolanaDestination>(destinations[0] ?? "stellar");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "confirming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<CircleHealth | null>(null);

  // A burn on screen: its signature, where it went, when.
  const [sent, setSent] = useState<Remembered | null>(null);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  const [attest, setAttest] = useState<Attest>("unknown");
  const [stellarDelivery, setStellarDelivery] = useState<Delivery>({ kind: "idle" });
  const [recipientSeen, setRecipientSeen] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  // A transfer this browser was following comes back on screen.
  useEffect(() => {
    const r = recallSolanaTransfer();
    if (r && destinations.includes(r.to)) {
      setTo(r.to);
      setSent(r);
    }
  }, [destinations]);

  const chain = to === "stellar" ? null : EVM_CHAINS[to];
  const finished =
    sent !== null &&
    (sent.to === "stellar"
      ? stellarDelivery.kind === "done"
      : delivery?.status === "known" && delivery.state === "delivered");
  useEffect(() => {
    onBusyChange?.(step !== "idle" || (sent !== null && !finished));
  }, [onBusyChange, step, sent, finished]);

  // Circle's quote for Solana to this EVM chain, refreshed while the form is open.
  useEffect(() => {
    if (!chain || sent) return;
    let cancelled = false;
    setHealth(null);
    const load = async () => {
      const h = await getRouteHealth(SOLANA_DOMAIN, chain.cctpDomainId);
      if (!cancelled) setHealth(h);
    };
    void load();
    const t = setInterval(load, HEALTH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [chain, sent]);

  // An EVM-bound burn: follow Circle's delivery until it lands.
  useEffect(() => {
    if (!sent || sent.to === "stellar") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await getDelivery(sent.tx, SOLANA_DOMAIN);
      if (cancelled) return;
      setDelivery(d);
      if (d.status === "known" && d.state === "delivered") {
        remember(null);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sent]);

  // A Stellar-bound burn: ask Circle until it attests, then ask the relayer to finish the mint.
  const completing = useRef(false);
  useEffect(() => {
    if (!sent || sent.to !== "stellar") return;
    if (stellarDelivery.kind === "done" || stellarDelivery.kind === "stuck") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tx = sent.tx;
    async function tick() {
      try {
        const s = await fetch(`/api/solana-source/status?tx=${encodeURIComponent(tx)}`, {
          cache: "no-store",
        });
        const body = (await s.json()) as {
          state?: Attest;
          delivered?: boolean;
          recipient?: string;
          refusal?: string;
        };
        if (cancelled) return;
        const state: Attest = body.state ?? "unknown";
        setAttest(state);
        if (body.recipient) setRecipientSeen(body.recipient);
        if (state === "complete" && body.delivered) {
          setStellarDelivery({ kind: "done", hash: null });
          remember(null);
          return;
        }
        if (state === "complete" && body.refusal) {
          setStellarDelivery({
            kind: "stuck",
            message: `Circle's message was refused: ${body.refusal}.`,
          });
          return;
        }
        if (state === "complete" && config.relayer && !completing.current) {
          completing.current = true;
          setStellarDelivery({ kind: "completing" });
          const c = await fetch("/api/stellar-inbound/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ src: SOLANA_DOMAIN, tx }),
          });
          const result = (await c.json()) as { status?: string; hash?: string; reason?: string };
          completing.current = false;
          if (cancelled) return;
          if (result.status === "delivered" || (result.status === "submitted" && result.hash)) {
            setStellarDelivery({ kind: "done", hash: result.hash ?? null });
            remember(null);
            return;
          }
          if (result.status === "refused" || result.status === "failed") {
            setStellarDelivery({
              kind: "stuck",
              message: result.reason ?? "The mint could not be completed.",
            });
            return;
          }
          setStellarDelivery({ kind: "idle" });
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
  }, [sent, stellarDelivery.kind, config.relayer]);

  const units = parseAmount(amount);
  const tier = health?.tiers.standard ?? null;
  const plan: FeePlan | null = useMemo(
    () =>
      chain && units !== null && tier
        ? planEvmFee({ amount: units, tier, destination: chain })
        : null,
    [chain, units, tier],
  );
  const routeDown = chain !== null && (health?.status === "down" || (health !== null && !tier));
  const quoteError = routeDown
    ? `Circle cannot deliver from Solana to ${chain?.name} right now${health?.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing has been burned. Try again shortly.`
    : plan && !plan.ok && plan.kind === "cap"
      ? plan.reason
      : null;

  const stellarMin = parseAmount(config.stellarMinUsdc) ?? 1_000_000n;
  const cap = config.maxUsdc !== null ? parseAmount(config.maxUsdc) : null;
  const amountError =
    amount.trim() === ""
      ? null
      : units === null
        ? "Enter an amount of USDC, up to 6 decimals."
        : cap !== null && units > cap
          ? `The limit is ${config.maxUsdc} USDC per transfer.`
          : to === "stellar" && units < stellarMin
            ? `Send at least ${config.stellarMinUsdc} USDC to Stellar.`
            : plan && !plan.ok && plan.kind !== "cap"
              ? plan.reason
              : null;

  const recipientOk =
    to === "stellar"
      ? /^G[A-Z2-7]{55}$/.test(recipient.trim())
      : chain !== null && checkAddressOn(chain, recipient.trim()).ok;
  const recipientError =
    recipient.trim() === "" || recipientOk
      ? null
      : to === "stellar"
        ? "That is not a Stellar account address."
        : chain
          ? (checkAddressOn(chain, recipient.trim()).error ??
            `That is not a ${chain.name} address.`)
          : null;

  const priced = to === "stellar" ? units !== null : plan?.ok === true && !routeDown;
  const canSend =
    solana !== null &&
    units !== null &&
    amountError === null &&
    recipientOk &&
    priced &&
    step === "idle";

  async function send() {
    if (!solana || units === null) return;
    setError(null);
    setStep("preparing");
    try {
      const res = await fetch("/api/solana-source/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender: solana.address,
          amount: amount.trim(),
          recipient: recipient.trim(),
          chain: to,
          maxFee: plan?.ok ? plan.maxFee.toString() : "0",
        }),
      });
      const body = (await res.json()) as { transaction?: string; error?: string };
      if (!res.ok || !body.transaction) {
        setError(body.error ?? "Could not prepare the transfer.");
        // A fee that moved is shown again from a fresh quote before anything is signed.
        if (res.status === 409 && chain) {
          setHealth(await getRouteHealth(SOLANA_DOMAIN, chain.cctpDomainId));
        }
        return;
      }
      setStep("signing");
      const tx = await sendSolana(body.transaction);
      // Remembered before it is confirmed: a burn that lands while this tab waits must not be lost.
      const record: Remembered = { tx, to, at: Date.now() };
      remember(record);
      setStep("confirming");
      try {
        await waitForSignature(proxyConnection(), tx);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (/rejected transaction/.test(text)) {
          // It landed and failed: nothing was burned, so there is nothing to follow.
          remember(null);
          throw err;
        }
        // Not seen in time is not failed; the receipt keeps asking Circle about it.
      }
      setDelivery(null);
      setAttest("unknown");
      setStellarDelivery({ kind: "idle" });
      setSent(record);
    } catch (err) {
      const text = reportError("solana burn failed", err);
      setError(
        /blockhash/i.test(text)
          ? "The transaction expired before it was signed: Solana transactions are good for about a minute. Nothing was burned. Send again."
          : text,
      );
    } finally {
      setStep("idle");
    }
  }

  function startOver() {
    remember(null);
    completing.current = false;
    setSent(null);
    setDelivery(null);
    setAttest("unknown");
    setStellarDelivery({ kind: "idle" });
    setRecipientSeen(null);
    setClaimError(null);
    setError(null);
    setAmount("");
  }

  async function claim() {
    if (!sent || !stellarKit || !stellarAddress) return;
    setClaimError(null);
    setClaiming(true);
    try {
      const r = await claimOnStellar(
        stellarKit,
        stellarAddress,
        sent.tx,
        "/api/solana-source/claim",
      );
      setStellarDelivery({ kind: "done", hash: r.delivered ? null : r.hash });
      remember(null);
    } catch (err) {
      setClaimError(reportError("solana claim on stellar failed", err));
    } finally {
      setClaiming(false);
    }
  }

  const heading = (
    <h2 id="bridge-heading" className="sr-only">
      Bridge USDC from Solana to {nameOf(to)}
    </h2>
  );

  if (sent) {
    if (sent.to === "stellar") {
      return (
        <>
          {heading}
          <div className="px-5 py-6 sm:px-6">
            {sourcePicker}
            <Progress
              digest={sent.tx}
              sourceName="Solana"
              burnUrl={solscan(sent.tx)}
              attest={attest}
              delivery={stellarDelivery}
              relayerEnabled={config.relayer}
              recipient={recipientSeen}
              stellarAddress={stellarAddress}
              claiming={claiming}
              claimError={claimError}
              onClaim={claim}
              onConnectStellar={() => openWallets(["stellar"])}
              onRetry={() => setStellarDelivery({ kind: "idle" })}
              onReset={startOver}
            />
          </div>
        </>
      );
    }
    const evm = EVM_CHAINS[sent.to];
    const early =
      delivery?.status === "known" &&
      delivery.state === "claimable" &&
      Date.now() - sent.at < CLAIM_GRACE_MS;
    const shown: DeliveryView | null = early
      ? { status: "known", state: "forwarding", forwardTxHash: null, reason: null }
      : delivery;
    return (
      <>
        {heading}
        <div className="px-5 py-6 sm:px-6">
          {sourcePicker}
          <div className="flex flex-col gap-5">
            <SubmittedNotice
              txHash={sent.tx}
              delivery={shown}
              destination={{
                name: evm.name,
                explorerTxUrl: (hash) => explorerTxUrl(evm, hash),
                claimCost: evm.claimCost,
              }}
              route={{
                eta: "This usually takes a minute or two.",
                burnUrl: solscan(sent.tx),
                claimHref: `/claim?tx=${encodeURIComponent(sent.tx)}&src=${SOLANA_DOMAIN}`,
              }}
            />
            <div className="flex items-center justify-between gap-3">
              {!finished && (
                <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
                  Safe to close this tab. Come back on the same browser and it picks up where it
                  left off.
                </p>
              )}
              <Button
                variant={finished ? "primary" : "quiet"}
                size="sm"
                onClick={startOver}
                className={finished ? "ml-auto" : ""}
              >
                {finished ? "Send another" : "Start over"}
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const label =
    step === "preparing"
      ? "Preparing"
      : step === "signing"
        ? "Confirm in your wallet"
        : step === "confirming"
          ? "Waiting for Solana"
          : "Burn on Solana";

  return (
    <>
      {heading}
      <div className="px-5 py-6 sm:px-6">
        {sourcePicker}
        <Notice tone="info" title="No Xebra fee from Solana" className="mb-6">
          Xebra has no contract on Solana, so it takes nothing on these transfers.{" "}
          {to === "stellar"
            ? "Circle charges nothing to Stellar either."
            : "You pay Circle's delivery fee, shown below."}{" "}
          Your wallet also pays Solana&rsquo;s own costs, {SOL_COST}. Check the recipient twice: a
          burn cannot be undone.
        </Notice>

        <div className="flex flex-col gap-6">
          {solana ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-eyebrow font-medium uppercase text-bone/40">Solana wallet</p>
                <p className="mt-1.5 text-sm text-bone/85">
                  {solana.walletName}{" "}
                  <span className="font-mono text-xs text-bone/50">{short(solana.address)}</span>
                </p>
              </div>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void disconnect("solana")}
                disabled={step !== "idle"}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => openWallets(["solana"])}>
              Connect a Solana wallet
            </Button>
          )}

          {destinations.length > 1 && (
            <div>
              <PickerLabel>Send to</PickerLabel>
              <ChainPicker<Chain>
                legend="Destination chain"
                name="solana-destination-chain"
                options={destinations.map((id) => ({ id, name: nameOf(id) }))}
                value={to}
                onChange={(id) => {
                  setError(null);
                  setRecipient("");
                  setTo(id as SolanaDestination);
                }}
                disabled={step !== "idle"}
              />
            </div>
          )}

          <Field
            id="solana-amount"
            label="Amount"
            hint={
              config.maxUsdc !== null
                ? `USDC on Solana. Up to ${config.maxUsdc} per transfer.`
                : "USDC on Solana."
            }
            error={amountError}
            trailing={<span className="text-xs text-bone/35">USDC</span>}
          >
            <Input
              id="solana-amount"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="tabular h-12 text-base"
              invalid={amountError !== null}
            />
          </Field>

          <Field
            id="solana-recipient"
            label={`${nameOf(to)} address`}
            hint={
              to === "stellar"
                ? "An existing account that already holds a USDC trustline. Starts with G."
                : `The wallet that receives USDC on ${nameOf(to)}. Circle delivers it; you need no ${chain?.nativeCurrency.symbol ?? "gas"}.`
            }
            error={recipientError}
          >
            <Input
              id="solana-recipient"
              autoComplete="off"
              spellCheck={false}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={to === "stellar" ? "G..." : "0x…"}
              className="h-12 font-mono text-xs"
              invalid={recipientError !== null}
            />
          </Field>

          {chain && (units !== null || quoteError) && (
            <div className="-mt-6">
              <EvmQuotePanel
                amount={units}
                plan={plan}
                error={quoteError}
                sourceName="Solana"
                destinationName={chain.name}
              />
            </div>
          )}

          {to === "stellar" && units !== null && amountError === null && (
            <InsetTray>
              <dl className="tabular space-y-3">
                <DataRow label="Amount" value={`${formatUsdc6(units)} USDC`} />
                <DataRow
                  label="Delivery"
                  value="0 USDC"
                  hint={
                    config.relayer
                      ? "Circle attests the burn and Xebra completes the mint on Stellar, at no charge."
                      : "Circle attests the burn; you complete the mint from a Stellar wallet for a few hundredths of an XLM."
                  }
                />
                <div className="pt-3">
                  <StripeRule className="mb-3 opacity-50" />
                  <DataRow
                    label="Recipient gets"
                    value={`${formatUsdc6(units)} USDC`}
                    emphasis
                    hint="All of it."
                  />
                </div>
              </dl>
            </InsetTray>
          )}

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
            {label}
          </Button>
        </div>
      </div>
    </>
  );
}
