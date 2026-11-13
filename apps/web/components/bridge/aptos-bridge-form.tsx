"use client";

import type { CircleHealth } from "@xebra/cctp-client";
import { type AptosTxEnvelope, aptosBurnArgsFromJson } from "@xebra/sdk/build";
import {
  EVM_CHAINS,
  type EvmChainId,
  type FeePlan,
  checkAddressOn,
  checkSolanaAddress,
  isEvmChainId,
  planEvmFee,
} from "@xebra/sdk/core";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Attest, type Delivery, Progress } from "../../app/sui/sui-client";
import { type DeliveryView, getDelivery, getRouteHealth } from "../../lib/circle-status";
import { reportError } from "../../lib/format-error";
import { feeDestination, routeDestination } from "../../lib/route-destination";
import { type RecipientResolution, resolveRecipient } from "../../lib/solana-recipient";
import { claimOnStellar } from "../../lib/sui-stellar/claim-client";
import {
  aptosWalletOnMainnet,
  currentAptosAccount,
  findAptosWallet,
  signAndSubmitAptos,
} from "../../lib/wallets/aptos";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { ArrowRight } from "../ui/icons";
import { Notice } from "../ui/notice";
import { useWallets } from "../wallet/wallet-provider";
import { CHAIN_NAMES } from "./chain-glyph";
import { ChainPicker, PickerLabel } from "./chain-picker";
import { EvmQuotePanel } from "./evm-quote-panel";
import { SubmittedNotice } from "./receipt";

/**
 * A transfer that starts on Aptos: burn native USDC with Circle's CCTP script, signed in the
 * person's own Aptos wallet (connected from the top bar like every other wallet).
 *
 *   - To an EVM chain, Arc or Solana, Circle's Forwarding Service mints on the far side. The fee is
 *     Circle's delivery fee only, priced with the rules of every direct route (`planEvmFee`), and
 *     the server prices it again before building the burn.
 *   - To Stellar nothing forwards: the relayer completes the mint, or the sender claims it from a
 *     Stellar wallet and pays a few hundredths of an XLM. Circle is paid nothing.
 *
 * No Xebra fee on these routes yet. The burn's hash is kept in this browser so closing the tab
 * does not lose a transfer on its way.
 */

const APTOS_DOMAIN = 9;
const STORAGE_KEY = "xebra.aptos.transfer";
const HASH = /^0x[0-9a-f]{64}$/;
const POLL_MS = 4_000;
const HEALTH_MS = 30_000;
/** Iris can show the attestation a moment before it shows the delivery under way. */
const CLAIM_GRACE_MS = 10 * 60_000;

export type AptosDestination = EvmChainId | "solana" | "stellar";

/** What `/api/aptos/config` says, once it says Aptos is on. */
export interface AptosSource {
  destinations: AptosDestination[];
  maxUsdc: string | null;
  relayer: boolean;
}

interface Remembered {
  tx: `0x${string}`;
  to: AptosDestination;
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

/** The Aptos transfer this browser was following, if any. */
export function recallAptosTransfer(): Remembered | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    if (typeof v.tx !== "string" || !HASH.test(v.tx) || !isDestination(v.to)) return null;
    return { tx: v.tx as `0x${string}`, to: v.to, at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    return null;
  }
}

/** Only names this build knows: a newer server cannot make the page render a chain it lacks. */
export function isDestination(v: unknown): v is AptosDestination {
  return v === "solana" || v === "stellar" || (typeof v === "string" && isEvmChainId(v));
}

const explorer = (tx: string) => `https://explorer.aptoslabs.com/txn/${tx}?network=mainnet`;
const nameOf = (d: AptosDestination) => CHAIN_NAMES[d];

function parseAmount(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const v = BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return v > 0n ? v : null;
}

const DECLINED = /reject|declin|den(y|ied)|cancel|closed|dismiss/i;

export function AptosBridgeForm({
  source,
  sourcePicker,
  onBusyChange,
}: {
  source: AptosSource;
  sourcePicker?: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { connections, stellarKit, open: openWallets } = useWallets();
  const aptos = connections.aptos ?? null;
  const stellarAddress = connections.stellar?.address ?? null;

  const [to, setTo] = useState<AptosDestination>(source.destinations[0] ?? "stellar");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<"idle" | "preparing" | "signing">("idle");
  const [error, setError] = useState<{ text: string; declined: boolean } | null>(null);
  const [sent, setSent] = useState<Remembered | null>(null);

  // A transfer this browser was following comes back on screen.
  useEffect(() => {
    const r = recallAptosTransfer();
    if (r && source.destinations.includes(r.to)) {
      setTo(r.to);
      setSent(r);
    }
  }, [source.destinations]);

  const toStellar = to === "stellar";
  const evm = to !== "stellar" && to !== "solana" ? EVM_CHAINS[to] : null;
  const units = parseAmount(amount);
  const capUnits = source.maxUsdc !== null ? parseAmount(source.maxUsdc) : null;
  const overCap = units !== null && capUnits !== null && units > capUnits;

  const recipientCheck = useMemo(() => {
    const r = recipient.trim();
    if (r === "") return { ok: false as const, error: null };
    if (toStellar) {
      return /^G[A-Z2-7]{55}$/.test(r)
        ? { ok: true as const, error: null }
        : { ok: false as const, error: "That is not a Stellar account address (G...)." };
    }
    const c = evm ? checkAddressOn(evm, r) : checkSolanaAddress(r);
    return c.ok
      ? { ok: true as const, error: null }
      : { ok: false as const, error: c.error ?? "That is not a valid address." };
  }, [recipient, toStellar, evm]);

  // Solana: CCTP mints into a USDC token account. Whether it exists decides the price (Circle
  // opens a missing one for more), so the transfer waits until the lookup answers.
  const [solana, setSolana] = useState<RecipientResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    if (to !== "solana" || !recipientCheck.ok) {
      setSolana(null);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    resolveRecipient(recipient.trim())
      .then((r) => !cancelled && setSolana(r))
      .catch(() => !cancelled && setSolana(null))
      .finally(() => !cancelled && setResolving(false));
    return () => {
      cancelled = true;
    };
  }, [to, recipientCheck.ok, recipient]);
  const opensAccount = to === "solana" && solana?.status === "missing";
  const solanaUnknown =
    to === "solana" && recipientCheck.ok && (resolving || !solana || solana.status === "unknown");

  // Circle's quote for Aptos to this chain, refreshed while the form is open. None for Stellar.
  const healthKey = `${to}:${opensAccount}`;
  const [healthState, setHealthState] = useState<{ key: string; value: CircleHealth | null }>();
  const health = healthState?.key === healthKey ? healthState.value : null;
  useEffect(() => {
    if (sent || to === "stellar") return;
    let cancelled = false;
    const key = `${to}:${opensAccount}`;
    const domain = routeDestination(to).cctpDomainId;
    const load = async () => {
      const h = await getRouteHealth(APTOS_DOMAIN, domain, opensAccount);
      if (!cancelled) setHealthState({ key, value: h });
    };
    void load();
    const t = setInterval(load, HEALTH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [to, opensAccount, sent]);

  const tier = health?.tiers.standard ?? null;
  const plan: FeePlan | null = useMemo(() => {
    if (to === "stellar" || units === null || !tier) return null;
    return planEvmFee({
      amount: units,
      tier,
      destination: feeDestination(routeDestination(to), opensAccount),
    });
  }, [units, tier, to, opensAccount]);
  const routeDown =
    !toStellar && (health?.status === "down" || (healthState?.key === healthKey && !tier));
  const quoteError = routeDown
    ? `Circle cannot deliver from Aptos to ${nameOf(to)} right now${health?.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing has been burned. Try again shortly.`
    : plan && !plan.ok && plan.kind === "cap"
      ? plan.reason
      : null;
  const amountError = overCap
    ? `The limit is ${source.maxUsdc} USDC per transfer.`
    : plan && !plan.ok && plan.kind !== "cap"
      ? plan.reason
      : null;

  const priced = toStellar ? units !== null : plan?.ok === true && !routeDown;
  const canSend =
    Boolean(aptos) &&
    units !== null &&
    !overCap &&
    recipientCheck.ok &&
    !solanaUnknown &&
    priced &&
    step === "idle";

  const send = useCallback(async () => {
    if (!aptos || units === null) return;
    setError(null);
    const wallet = findAptosWallet(aptos.walletKey);
    if (!wallet) {
      setError({
        text: "Your Aptos wallet is no longer available. Connect it again.",
        declined: false,
      });
      return;
    }
    setStep("preparing");
    try {
      if ((await aptosWalletOnMainnet(wallet)) === false) {
        setError({
          text: `${wallet.name} is not on Aptos mainnet. Switch it to mainnet, then send again.`,
          declined: false,
        });
        return;
      }
      // The account the wallet will sign with now, which may not be the one it connected with.
      const sender = (await currentAptosAccount(wallet)) ?? aptos.address;
      const res = await fetch("/api/aptos/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender,
          amount: amount.trim(),
          to,
          recipient: recipient.trim(),
          ...(plan?.ok ? { maxFee: plan.maxFee.toString() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        transaction?: { arguments: Parameters<typeof aptosBurnArgsFromJson>[0] };
        envelope?: Record<keyof Omit<AptosTxEnvelope, "sender" | "chainId">, string>;
      };
      if (!res.ok || !body.transaction || !body.envelope) {
        setError({ text: body.error ?? "Could not prepare the transfer.", declined: false });
        // A fee that moved is shown again from a fresh quote before anything is signed.
        if (res.status === 409 && to !== "stellar") {
          const domain = routeDestination(to).cctpDomainId;
          const h = await getRouteHealth(APTOS_DOMAIN, domain, opensAccount);
          setHealthState({ key: healthKey, value: h });
        }
        return;
      }
      // Read back, shape-checked, and refused unless it burns native USDC.
      const args = aptosBurnArgsFromJson(body.transaction.arguments);
      const envelope: AptosTxEnvelope = {
        sender: sender as `0x${string}`,
        sequenceNumber: BigInt(body.envelope.sequenceNumber),
        maxGasAmount: BigInt(body.envelope.maxGasAmount),
        gasUnitPrice: BigInt(body.envelope.gasUnitPrice),
        expirationTimestampSecs: BigInt(body.envelope.expirationTimestampSecs),
        chainId: 1,
      };
      setStep("signing");
      const tx = await signAndSubmitAptos(wallet, args, envelope);
      const r = { tx, to, at: Date.now() };
      remember(r);
      setSent(r);
    } catch (err) {
      const text = reportError("aptos burn failed", err);
      setError({ text, declined: DECLINED.test(text) });
    } finally {
      setStep("idle");
    }
  }, [aptos, units, amount, to, recipient, plan, opensAccount, healthKey]);

  const busy = step !== "idle" || sent !== null;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function startOver() {
    remember(null);
    setSent(null);
    setError(null);
    setAmount("");
  }

  let body: React.ReactNode;
  if (sent && sent.to === "stellar") {
    body = (
      <ToStellar
        tx={sent.tx}
        relayerEnabled={source.relayer}
        stellarAddress={stellarAddress}
        claim={(payer) => {
          if (!stellarKit) throw new Error("The Stellar wallet is still loading.");
          return claimOnStellar(stellarKit, payer, sent.tx, { url: "/api/aptos/claim", key: "tx" });
        }}
        onConnectStellar={() => openWallets(["stellar"])}
        onReset={startOver}
      />
    );
  } else if (sent) {
    body = (
      <Forwarded
        tx={sent.tx}
        to={sent.to as Exclude<AptosDestination, "stellar">}
        sentAt={sent.at}
        onReset={startOver}
      />
    );
  } else {
    const label =
      step === "preparing"
        ? "Preparing"
        : step === "signing"
          ? "Confirm in your wallet"
          : "Burn on Aptos";
    body = (
      <div className="flex flex-col gap-6">
        {aptos ? null : (
          <Notice tone="info" title="Connect an Aptos wallet">
            Petra, Nightly, OKX or any wallet that supports Aptos&rsquo;s Wallet Standard signs the
            burn. You pay the Aptos network fee in APT.
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => openWallets(["aptos"])}>
                Connect an Aptos wallet
              </Button>
            </div>
          </Notice>
        )}

        {source.destinations.length > 1 && (
          <div>
            <PickerLabel>Send to</PickerLabel>
            <ChainPicker<AptosDestination>
              legend="Destination chain"
              name="aptos-destination"
              options={source.destinations.map((id) => ({ id, name: nameOf(id) }))}
              value={to}
              onChange={(id) => {
                setError(null);
                // An address for one kind of chain is never right for another.
                const kind = (d: AptosDestination) =>
                  d === "solana" || d === "stellar" ? d : "evm";
                if (kind(id) !== kind(to)) setRecipient("");
                setTo(id);
              }}
              disabled={step !== "idle"}
            />
          </div>
        )}

        <Field
          id="aptos-amount"
          label="Amount"
          hint={
            source.maxUsdc !== null
              ? `USDC on Aptos. Up to ${source.maxUsdc} per transfer.`
              : "USDC on Aptos."
          }
          error={amount.trim() !== "" ? amountError : null}
          trailing={<span className="text-xs text-bone/35">USDC</span>}
        >
          <Input
            id="aptos-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="tabular h-12 text-base"
            invalid={amount.trim() !== "" && (units === null || amountError !== null)}
          />
        </Field>

        <Field
          id="aptos-recipient"
          label={`${nameOf(to)} address`}
          hint={
            toStellar
              ? "An existing account that already holds a USDC trustline. Starts with G."
              : to === "solana"
                ? solana?.status === "missing"
                  ? "This wallet has no USDC account yet. Circle opens one during delivery, for a higher fee."
                  : "The wallet that receives USDC on Solana. Circle delivers it; you need no SOL."
                : `The wallet that receives USDC on ${nameOf(to)}. Circle delivers it; you need no ${evm?.nativeCurrency.symbol ?? "gas"}.`
          }
          error={recipientCheck.error}
        >
          <Input
            id="aptos-recipient"
            autoComplete="off"
            spellCheck={false}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={toStellar ? "G..." : to === "solana" ? "Recipient wallet" : "0x…"}
            className="h-12 font-mono text-xs"
            invalid={recipientCheck.error !== null}
          />
        </Field>

        {toStellar
          ? units !== null && (
              <Notice tone="info" title="No delivery fee to Stellar" className="-mt-2">
                Circle does not forward into Stellar, so it is paid nothing and the recipient gets
                the full amount.{" "}
                {source.relayer
                  ? "Xebra completes the mint on Stellar for transfers of 1 USDC or more; for less, you finish it from a Stellar wallet for a few hundredths of an XLM."
                  : "You finish the mint from a Stellar wallet once Circle attests the burn, for a few hundredths of an XLM."}
              </Notice>
            )
          : (units !== null || quoteError) && (
              <div className="-mt-6">
                <EvmQuotePanel
                  amount={units}
                  plan={plan}
                  error={quoteError}
                  sourceName="Aptos"
                  destinationName={nameOf(to)}
                />
              </div>
            )}

        {error &&
          (error.declined ? (
            <Notice tone="info" title="Wallet request cancelled">
              The wallet reported: {error.text} If you did not cancel it yourself, the wallet window
              may have been blocked or closed. Allow pop-ups for this site, then try again.
            </Notice>
          ) : (
            <Notice tone="alarm" title="Could not send">
              {error.text}
            </Notice>
          ))}

        <Button
          size="lg"
          disabled={!canSend}
          onClick={send}
          trailing={<ArrowRight className="h-4 w-4" />}
        >
          {label}
        </Button>
      </div>
    );
  }

  return (
    <>
      <h2 id="bridge-heading" className="sr-only">
        Bridge USDC from Aptos to {nameOf(to)}
      </h2>
      <div className="px-5 py-6 sm:px-6">
        {sourcePicker}
        <Notice tone="info" title="New route on mainnet" className="mb-6">
          Real USDC{source.maxUsdc !== null ? `, up to ${source.maxUsdc} per transfer` : ""}. Check
          the recipient address twice: the mint goes only to the address you enter, and a burn
          cannot be undone.
        </Notice>
        {body}
      </div>
    </>
  );
}

/** A burn Circle forwards: its receipt, followed until Circle has delivered it. */
function Forwarded({
  tx,
  to,
  sentAt,
  onReset,
}: {
  tx: `0x${string}`;
  to: Exclude<AptosDestination, "stellar">;
  sentAt: number;
  onReset: () => void;
}) {
  const dest = routeDestination(to);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  const delivered = delivery?.status === "known" && delivery.state === "delivered";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await getDelivery(tx, APTOS_DOMAIN);
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
  }, [tx]);

  const early =
    delivery?.status === "known" &&
    delivery.state === "claimable" &&
    Date.now() - sentAt < CLAIM_GRACE_MS;
  const shown: DeliveryView | null = early
    ? { status: "known", state: "forwarding", forwardTxHash: null, reason: null }
    : delivery;

  return (
    <div className="flex flex-col gap-5">
      <SubmittedNotice
        txHash={tx}
        delivery={shown}
        destination={{
          name: dest.name,
          explorerTxUrl: dest.explorerTxUrl,
          claimCost: dest.claimCost,
        }}
        route={{
          eta: "This usually takes a few minutes.",
          burnUrl: explorer(tx),
          claimHref: `/claim?tx=${encodeURIComponent(tx)}&src=${APTOS_DOMAIN}`,
        }}
      />
      <div className="flex items-center justify-between gap-3">
        {!delivered && (
          <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
            Safe to close this tab. Come back on the same browser and it picks up where it left off.
          </p>
        )}
        <Button
          variant={delivered ? "primary" : "quiet"}
          size="sm"
          onClick={onReset}
          className={delivered ? "ml-auto" : ""}
        >
          {delivered ? "Send another" : "Start over"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A burn into Stellar: wait for Circle to attest it, then have the relayer finish the mint, or let
 * the sender finish it from a Stellar wallet. The same steps and screen as Sui to Stellar.
 */
function ToStellar({
  tx,
  relayerEnabled,
  stellarAddress,
  claim,
  onConnectStellar,
  onReset,
}: {
  tx: `0x${string}`;
  relayerEnabled: boolean;
  stellarAddress: string | null;
  claim: (payer: string) => Promise<{ hash: string; delivered: boolean }>;
  onConnectStellar: () => void;
  onReset: () => void;
}) {
  const [attest, setAttest] = useState<Attest>("unknown");
  const [delivery, setDelivery] = useState<Delivery>({ kind: "idle" });
  const [recipient, setRecipient] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const completing = useRef(false);

  useEffect(() => {
    if (delivery.kind === "done" || delivery.kind === "stuck") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const s = await fetch(`/api/aptos/status?tx=${tx}`, { cache: "no-store" });
        const body = (await s.json()) as {
          state?: Attest;
          delivered?: boolean;
          recipient?: string;
          refusal?: string;
        };
        const state: Attest = body.state ?? "unknown";
        if (cancelled) return;
        setAttest(state);
        if (body.recipient) setRecipient(body.recipient);

        if (state === "complete" && body.delivered) {
          setDelivery({ kind: "done", hash: null });
          remember(null);
          return;
        }
        if (state === "complete" && body.refusal) {
          setDelivery({
            kind: "stuck",
            message: `This burn cannot be completed on Stellar (${body.refusal}).`,
          });
          return;
        }
        if (state === "complete" && relayerEnabled && !completing.current) {
          completing.current = true;
          setDelivery({ kind: "completing" });
          const c = await fetch("/api/stellar-inbound/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ src: APTOS_DOMAIN, tx }),
          });
          const result = (await c.json()) as { status?: string; hash?: string; reason?: string };
          completing.current = false;
          if (cancelled) return;
          if (result.status === "delivered" || (result.status === "submitted" && result.hash)) {
            setDelivery({ kind: "done", hash: result.hash ?? null });
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
  }, [tx, delivery.kind, relayerEnabled]);

  async function onClaim() {
    if (!stellarAddress) return;
    setClaimError(null);
    setClaiming(true);
    try {
      const r = await claim(stellarAddress);
      setDelivery({ kind: "done", hash: r.delivered ? null : r.hash });
      remember(null);
    } catch (err) {
      setClaimError(reportError("aptos claim on stellar failed", err));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <Progress
      digest={tx}
      attest={attest}
      delivery={delivery}
      relayerEnabled={relayerEnabled}
      recipient={recipient}
      stellarAddress={stellarAddress}
      claiming={claiming}
      claimError={claimError}
      onClaim={onClaim}
      onConnectStellar={onConnectStellar}
      onRetry={() => setDelivery({ kind: "idle" })}
      onReset={onReset}
      sourceName="Aptos"
      burnUrl={explorer(tx)}
    />
  );
}
