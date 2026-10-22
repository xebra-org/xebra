"use client";

import type { CircleHealth } from "@xebra/cctp-client";
import type { BurnRecipient } from "@xebra/cctp-evm";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bytesToHex } from "viem";
import { type DeliveryView, getDelivery, getRouteHealth } from "../../lib/circle-status";
import type { DeepLink } from "../../lib/deep-link";
import { env } from "../../lib/env";
import { checkAddressOn } from "../../lib/evm-address";
import {
  ARC_GAS_RESERVE_UNITS,
  EVM_STEP_LABEL,
  getUsdcBalance6,
  spendableUsdc,
  submitEvmBridge,
  watchBurn,
} from "../../lib/evm-bridge";
import {
  type EnabledRoutes,
  type EvmChain,
  type RouteDestinationId,
  evmDestinationsFrom,
  explorerTxUrl,
  wrapperFor,
} from "../../lib/evm-chains";
import {
  type FeePlan,
  type FeeTier,
  planEvmFee,
  planWrapperFee,
  speedFeeFor,
} from "../../lib/evm-forward-fee";
import { ensureChain } from "../../lib/evm-rpc";
import { type WrapperSettings, getWrapperSettings, termsFor } from "../../lib/evm-wrapper";
import { formatError, reportError } from "../../lib/format-error";
import { unitsToInput } from "../../lib/max-amount";
import {
  type RouteDestination,
  feeDestination,
  routeDestination,
} from "../../lib/route-destination";
import {
  type RecipientResolution,
  checkSolanaAddress,
  resolveRecipient,
} from "../../lib/solana-address";
import { formatUsdc6, parseUsdc6 } from "../../lib/usdc6";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { ArrowRight } from "../ui/icons";
import { Notice } from "../ui/notice";
import { StripeRule } from "../ui/stripe-rule";
import { useWallets } from "../wallet/wallet-provider";
import { ChainPicker, PickerLabel } from "./chain-picker";
import { EvmQuotePanel } from "./evm-quote-panel";
import { MaxAmount, QUICK_AMOUNTS, QuickAmount } from "./quick-amount";
import { type ReceiptRoute, SubmittedNotice } from "./receipt";
import { ArcRecipientPanel, RecipientPanel, UseMyWallet } from "./recipient-panels";
import { RouteTrack } from "./route-track";
import { type Speed, SpeedPicker } from "./speed-picker";

/**
 * Moving USDC between Arc and another EVM chain, or from Arc to Solana, by calling Circle's
 * contracts directly.
 *
 * The sibling of `StellarBridgeForm`, and deliberately a sibling and not a branch inside it. That
 * form talks to a Soroban contract that bounds the fee and fixes the hook. This one calls Circle
 * directly unless the source chain has Xebra's own wrapper pinned and switched on
 * (`NEXT_PUBLIC_ARC_USE_WRAPPER`); either way every bound is applied here before signing
 * (`lib/evm-forward-fee.ts`, `lib/evm-bridge.ts`), and through the wrapper the contract applies
 * them again. The two forms never share a code path that money runs through.
 *
 * # What is different for the person
 *
 *   - **The wallet has to be on the source chain.** Circle's contracts have one address on every
 *     chain, so a read made on the wrong chain answers plausibly and wrongly. Nothing is read or
 *     sent until the wallet says it is on the chain the transfer starts from; until then the
 *     button is "Switch wallet to …".
 *   - **Two prompts.** An approval for the amount, then the transfer.
 *   - **The fee comes out of the amount.** The wallet is debited what was typed and the recipient
 *     is minted the rest. There is no fee of ours on this route.
 *   - **A speed, where there is one to choose.** See `SpeedPicker`.
 */

/**
 * How long Circle is given to deliver before an attested transfer is called claimable.
 *
 * Circle's record of a burn can show it attested a moment before it shows the delivery under way.
 * Every transfer made here asks for delivery, so in that window "claimable" means "not picked up
 * yet", and sending someone to pay gas for a mint Circle is about to do would be the wrong advice.
 */
const CLAIM_GRACE_MS = 10 * 60_000;

/** The speed a route actually has: Fast only where the chain offers it and Circle is quoting it. */
function tierFor(health: CircleHealth | null, source: EvmChain, speed: Speed): FeeTier | null {
  const tiers = health?.tiers;
  if (!tiers) return null;
  if (speed === "fast" && source.fast) return tiers.fast;
  return tiers.standard;
}

interface Sent {
  destination: RouteDestination;
  fast: boolean;
  at: number;
}

export function EvmBridgeForm({
  source,
  routes,
  sourcePicker,
  onBusyChange,
  prefill,
}: {
  source: EvmChain;
  routes: EnabledRoutes;
  /** The "Send from" control, owned by the screen because it chooses which form this is. */
  sourcePicker?: React.ReactNode;
  /** True while a transfer is being signed or its receipt is on show. */
  onBusyChange?: (busy: boolean) => void;
  /** What a link asked to have filled in. Applied once; never submits. */
  prefill?: DeepLink | null;
}) {
  const { connections, open: openWallets, syncEvmChain } = useWallets();
  const wallet = connections.evm ?? null;
  const address = wallet?.address ?? null;
  const provider = wallet?.provider ?? null;
  // Unknown is not "yes". A wallet that will not say which chain it is on is asked to switch.
  const onSource = wallet?.chainId === source.chainId;

  const destinations = useMemo(
    () => evmDestinationsFrom(source.id, routes).map(routeDestination),
    [source.id, routes],
  );
  const [destId, setDestId] = useState<RouteDestinationId>(destinations[0]?.id ?? "arc");
  const dest = useMemo(() => routeDestination(destId), [destId]);

  // Xebra's wrapper on this chain, when the build uses it, and its live settings: `undefined` while
  // the first read is out, null when it could not be read. A transfer is never priced without them.
  const wrapperAddress = wrapperFor(source, env.arcUseWrapper);
  const [wrapperSettings, setWrapperSettings] = useState<WrapperSettings | null | undefined>(
    undefined,
  );

  const [amountInput, setAmountInput] = useState("5");
  const [recipientInput, setRecipientInput] = useState("");

  // A link's fields go in once; a destination this source does not send to is skipped, and so is
  // the recipient written for it.
  const prefillApplied = useRef(false);
  useEffect(() => {
    if (!prefill || prefillApplied.current) return;
    prefillApplied.current = true;
    if (prefill.amount) setAmountInput(prefill.amount);
    const target = prefill.to && destinations.some((d) => d.id === prefill.to) ? prefill.to : null;
    if (target) setDestId(target);
    if (prefill.recipient && (!prefill.to || target)) setRecipientInput(prefill.recipient);
  }, [prefill, destinations]);
  const [speed, setSpeed] = useState<Speed>("fast");
  const [healthState, setHealthState] = useState<{
    key: string;
    value: CircleHealth | null;
  } | null>(null);
  /** Null while unknown — an unread balance must not read as "you have nothing". */
  const [balance, setBalance] = useState<bigint | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // What the receipt describes, fixed at signing so nothing chosen afterwards can rewrite it.
  const [sent, setSent] = useState<Sent | null>(null);
  const [reverted, setReverted] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);

  const busy = submitting || Boolean(txHash);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const amount = useMemo(() => {
    try {
      return parseUsdc6(amountInput);
    } catch {
      return null;
    }
  }, [amountInput]);

  const amountError = useMemo(() => {
    if (amountInput.trim() === "") return null;
    try {
      return parseUsdc6(amountInput) <= 0n ? "Enter an amount greater than zero." : null;
    } catch (err) {
      return formatError(err);
    }
  }, [amountInput]);

  const recipientCheck = useMemo(
    () =>
      dest.evm ? checkAddressOn(dest.evm, recipientInput) : checkSolanaAddress(recipientInput),
    [dest, recipientInput],
  );

  // Solana only. CCTP mints into a USDC token account, not a wallet, so the wallet typed is
  // resolved to its account before anything is priced. A missing account is a price, not a wall:
  // Circle opens it during delivery for a higher fee, and the burn says so in its hook.
  const [solanaRecipient, setSolanaRecipient] = useState<RecipientResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    if (dest.evm || !recipientCheck.ok) {
      setSolanaRecipient(null);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    resolveRecipient(recipientInput.trim())
      .then((r) => {
        if (!cancelled) setSolanaRecipient(r);
      })
      .catch(() => {
        if (!cancelled) setSolanaRecipient(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dest.evm, recipientCheck.ok, recipientInput]);
  const opensAccount = !dest.evm && solanaRecipient?.status === "missing";
  // Not knowing is not "it exists": pricing as if it did would under-pay Circle for a wallet that
  // needs its account opened, so an unverified Solana recipient holds the transfer instead.
  const recipientUnverified =
    !dest.evm &&
    recipientCheck.ok &&
    (resolving || !solanaRecipient || solanaRecipient.status === "unknown");

  // A health reading only counts for the route it was taken for, and on Solana for whether it
  // priced opening the account.
  const healthKey = `${source.cctpDomainId}>${dest.cctpDomainId}:${opensAccount}`;
  const health = healthState?.key === healthKey ? healthState.value : null;
  const healthUnavailable = healthState?.key === healthKey && healthState.value === null;

  // Ask whether Circle can carry this route before anyone is invited to sign. Re-checked every
  // minute while the page is open, and again immediately before signing.
  useEffect(() => {
    let cancelled = false;
    const key = `${source.cctpDomainId}>${dest.cctpDomainId}:${opensAccount}`;
    const check = () =>
      getRouteHealth(source.cctpDomainId, dest.cctpDomainId, opensAccount).then((h) => {
        if (!cancelled) setHealthState({ key, value: h });
      });
    void check();
    const timer = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [source.cctpDomainId, dest.cctpDomainId, opensAccount]);

  const fastOffered = source.fast && Boolean(health?.tiers?.fast);
  const chosenSpeed: Speed = fastOffered ? speed : "standard";
  const tier = tierFor(health, source, chosenSpeed);

  // The wrapper's settings change only through its timelock, but a pause is instant: re-read every
  // minute, and again just before signing.
  useEffect(() => {
    if (!wrapperAddress) return;
    let cancelled = false;
    const read = () =>
      getWrapperSettings(source.cctpDomainId).then((s) => {
        if (!cancelled) setWrapperSettings(s);
      });
    void read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wrapperAddress, source.cctpDomainId]);

  /** Prices a transfer the way it will be sent: through the wrapper, or straight to Circle. */
  const planFor = useCallback(
    (
      value: bigint,
      feeTier: FeeTier,
      destination: RouteDestination,
      opening: boolean,
      settings: WrapperSettings | null | undefined,
    ): FeePlan | null => {
      const feeDest = feeDestination(destination, opening);
      if (!wrapperAddress)
        return planEvmFee({ amount: value, tier: feeTier, destination: feeDest });
      if (!settings) return null;
      return planWrapperFee({
        amount: value,
        tier: feeTier,
        destination: feeDest,
        terms: termsFor(settings, destination.cctpDomainId),
        opensAccount: opening,
        sourceName: source.name,
      });
    },
    [wrapperAddress, source.name],
  );

  const plan = useMemo(
    () =>
      amount !== null && amount > 0n && tier
        ? planFor(amount, tier, dest, opensAccount, wrapperSettings)
        : null,
    [amount, tier, dest, opensAccount, wrapperSettings, planFor],
  );
  const minimumProblem =
    plan && !plan.ok && (plan.kind === "minimum" || plan.kind === "maximum") ? plan.reason : null;
  const amountProblem = amountError ?? minimumProblem;
  const quoteError =
    plan && !plan.ok && plan.kind === "cap"
      ? plan.reason
      : wrapperAddress && wrapperSettings === null
        ? `We could not read Xebra's contract on ${source.name} just now. Try again in a moment.`
        : healthUnavailable
          ? "We could not get Circle's delivery fee just now. Try again in a moment."
          : null;

  // The wallet's USDC on the source chain. Only asked once the wallet is known to be on that
  // chain: the token address is a different contract, or nothing at all, anywhere else.
  //
  // `txHash` is a dependency without being read: a completed transfer is exactly when the figure
  // on screen has gone stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch after a completed transfer.
  useEffect(() => {
    if (!provider || !address || !onSource) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getUsdcBalance6(provider, source, address)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        // A failed read must not look like a zero balance. Leave it unknown; the transfer checks
        // again itself before it asks for a signature.
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, address, onSource, source, txHash]);

  // Only a *known* shortfall blocks. An unread balance is not a zero balance.
  const spendable = balance === null ? null : spendableUsdc(source, balance);
  const short = spendable !== null && amount !== null && amount > spendable;
  // Null until the balance has been read, so Max is never offered on a guess.
  const maxInput = spendable !== null && spendable > 0n ? unitsToInput(spendable, 6) : null;

  // Poll until Circle reports an outcome. As on the Stellar receipt, except that "claimable" is
  // not final here until Circle has had time to deliver (`CLAIM_GRACE_MS`).
  useEffect(() => {
    if (!txHash || !sent || reverted) {
      setDelivery(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const result = await getDelivery(txHash, source.cctpDomainId);
      if (cancelled) return;
      setDelivery(result);
      const waited = Date.now() - sent.at;
      const settled =
        result.status === "known" &&
        (result.state === "delivered" ||
          result.state === "failed" ||
          (result.state === "claimable" && waited >= CLAIM_GRACE_MS));
      if (!settled) timer = setTimeout(poll, waited < 120_000 ? 5_000 : 15_000);
    };
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [txHash, sent, reverted, source.cctpDomainId]);

  // Within the grace period an attested-but-undelivered transfer is shown as what it almost
  // certainly is: on its way.
  const shownDelivery: DeliveryView | null =
    delivery?.status === "known" &&
    delivery.state === "claimable" &&
    sent &&
    Date.now() - sent.at < CLAIM_GRACE_MS
      ? { ...delivery, state: "forwarding" }
      : delivery;

  function chooseDestination(id: RouteDestinationId) {
    if (id === destId) return;
    // Between EVM chains the address stays: the same key controls the same address on each, and
    // it is checked again against the new chain's own unsafe addresses. To or from Solana it is
    // cleared, because an address valid on one is never valid on the other.
    if ((id === "solana") !== (destId === "solana")) setRecipientInput("");
    setDestId(id);
    setSubmitError(null);
  }

  const connect = useCallback(() => openWallets(["evm"]), [openWallets]);

  async function switchChain() {
    if (!provider) return;
    setSwitching(true);
    setSubmitError(null);
    try {
      await ensureChain(provider, source);
    } catch (err) {
      setSubmitError(reportError("network switch failed", err));
    } finally {
      // Asked whatever happened: a wallet that switched without announcing it is still on the
      // right chain, and one that announced without switching is not.
      await syncEvmChain();
      setSwitching(false);
    }
  }

  const ready =
    Boolean(provider && address && onSource && plan?.ok && recipientCheck.ok) &&
    !recipientUnverified &&
    !short &&
    health?.status !== "down" &&
    !submitting;

  async function bridge() {
    if (!provider || !address || !plan?.ok || amount === null || !recipientCheck.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    setTxHash(null);
    setReverted(false);
    const destination = dest;
    const speedAtSigning = chosenSpeed;
    // What the burn names as recipient, fixed now. For Solana: the resolved token account, never
    // the wallet; and the wallet only as the owner Circle opens that account for, if it must.
    const opening = opensAccount;
    let recipient: BurnRecipient;
    if (destination.evm) {
      recipient = recipientInput.trim();
    } else {
      if (!solanaRecipient || recipientUnverified || !recipientCheck.bytes) {
        setSubmitting(false);
        return;
      }
      recipient = {
        kind: "solana",
        tokenAccount: bytesToHex(solanaRecipient.tokenAccountBytes),
        createAccountFor: opening ? bytesToHex(recipientCheck.bytes) : undefined,
      };
    }
    const priceNow = async (): Promise<{ tier: FeeTier; maxFee: bigint; fee: bigint } | string> => {
      // Through the wrapper its settings are read again too: a pause or a lowered cap is instant.
      const settings = wrapperAddress ? await getWrapperSettings(source.cctpDomainId) : undefined;
      if (wrapperAddress) {
        setWrapperSettings(settings);
        if (!settings) return `We could not read Xebra's contract on ${source.name} just now.`;
      }
      const fresh = await getRouteHealth(source.cctpDomainId, destination.cctpDomainId, opening);
      setHealthState({ key: healthKey, value: fresh });
      if (fresh?.status === "down") {
        return `Circle is not able to deliver to ${destination.name} right now. ${fresh.reasons[0] ?? ""}`.trim();
      }
      const freshTier = tierFor(fresh, source, speedAtSigning);
      if (!freshTier) {
        return speedAtSigning === "fast" && fresh?.tiers?.standard
          ? "Circle is not offering Fast on this route right now. Choose Standard, or try again shortly."
          : "We could not get Circle's delivery fee just now.";
      }
      const latest = planFor(amount, freshTier, destination, opening, settings);
      if (!latest) return `We could not read Xebra's contract on ${source.name} just now.`;
      return latest.ok
        ? { tier: freshTier, maxFee: latest.maxFee, fee: latest.fee }
        : latest.reason;
    };

    try {
      // The check the page already ran may be a minute old. Ask again now that the user has
      // committed, because this is the last moment declining costs nothing.
      const priced = await priceNow();
      if (typeof priced === "string") {
        setSubmitError(`${priced} Nothing was sent.`);
        return;
      }
      // Circle's fee drifts by a few percent over minutes. If the total went up, stop and show it
      // instead of signing a number the user did not see. Through the wrapper a small rise is
      // often absorbed by Xebra's own fee, and then the total, which is what the user saw, holds.
      if (priced.fee > plan.fee) {
        setSubmitError(
          `The fee moved while you were reviewing: it is now ${formatUsdc6(priced.fee)} USDC, was ${formatUsdc6(plan.fee)}. Nothing was sent. Check the new total and confirm again.`,
        );
        return;
      }

      const { txHash: hash } = await submitEvmBridge({
        provider,
        from: address,
        source,
        destination,
        recipient,
        amount,
        maxFee: priced.maxFee,
        finality: priced.tier.finalityThreshold,
        via: wrapperAddress ? { address: wrapperAddress, maxWrapperFee: priced.fee } : null,
        onStep: (s) => setStep(EVM_STEP_LABEL[s](source.name)),
        // An approval can take minutes on a busy chain; the fee is asked for again after it.
        currentMaxFee: async () => {
          const again = await priceNow();
          if (typeof again === "string") {
            throw new Error(
              `${again} Nothing was burned; the approval is still in place. Send again.`,
            );
          }
          return again.maxFee;
        },
      });

      // The burn is submitted and cannot be recalled. Circle attests it and its forwarding
      // service mints on the destination; the effect above watches for the outcome.
      setSent({
        destination,
        fast: priced.tier.finalityThreshold === 1000,
        at: Date.now(),
      });
      setTxHash(hash);
      // Only a revert changes what the page says, so that is all this waits to hear.
      void watchBurn(provider, hash)
        .then((outcome) => {
          if (outcome === "reverted") setReverted(true);
        })
        .catch(() => undefined);
    } catch (err) {
      setSubmitError(reportError("transfer failed", err));
    } finally {
      setSubmitting(false);
      setStep(null);
      void syncEvmChain();
    }
  }

  function startAgain() {
    setTxHash(null);
    setSent(null);
    setReverted(false);
    setSubmitError(null);
  }

  const receiptRoute: ReceiptRoute | undefined =
    txHash && sent
      ? {
          eta: sent.fast
            ? "A Fast transfer usually lands in under a minute."
            : `A Standard transfer from ${source.name} usually takes ${source.standardEta}.`,
          burnUrl: explorerTxUrl(source, txHash),
          claimHref: `/claim?tx=${encodeURIComponent(txHash)}&src=${source.cctpDomainId}`,
          expires: sent.fast,
          claimableLine: `Circle has attested this transfer but has not delivered it to ${sent.destination.name}.`,
        }
      : undefined;

  const fastFee =
    amount !== null && amount > 0n && health?.tiers?.fast
      ? speedFeeFor(amount, health.tiers.fast.minimumFeePpb)
      : null;

  return (
    <>
      <h2 id="bridge-heading" className="sr-only">
        Bridge USDC from {source.name} to {dest.name}
      </h2>

      <div className="px-5 py-5 sm:px-6">
        <RouteTrack
          from={source.id}
          to={destId}
          active={submitting}
          fromDetail={
            address ? (
              <span className="tabular font-mono">
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
            ) : (
              "No wallet connected"
            )
          }
          toDetail={recipientCheck.ok ? "Address checks out" : "Native USDC"}
        />
      </div>

      <StripeRule />

      <div className="px-5 py-6 sm:px-6">
        {sourcePicker}

        <Field
          id="amount"
          label="You send"
          error={amountProblem}
          hint={
            balance !== null ? (
              <span className="tabular">
                {formatUsdc6(balance)} USDC in this wallet on {source.name}
                {source.id === "arc"
                  ? `. Arc pays gas in USDC, so ${formatUsdc6(ARC_GAS_RESERVE_UNITS)} is kept back.`
                  : "."}
              </span>
            ) : undefined
          }
          trailing={
            <div className="flex items-center gap-1">
              {QUICK_AMOUNTS.map((preset) => (
                <QuickAmount
                  key={preset}
                  value={preset}
                  active={amountInput.trim() === preset}
                  onSelect={setAmountInput}
                />
              ))}
              {maxInput !== null && (
                <MaxAmount
                  value={maxInput}
                  active={amountInput.trim() === maxInput}
                  onSelect={setAmountInput}
                />
              )}
            </div>
          }
        >
          <div className="relative">
            <Input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              invalid={Boolean(amountProblem)}
              aria-invalid={amountProblem ? "true" : undefined}
              aria-describedby={
                amountProblem ? "amount-error" : balance !== null ? "amount-hint" : undefined
              }
              className="tabular h-16 pr-24 text-[1.75rem] font-medium tracking-[-0.02em]"
            />
            <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-[0.8125rem] font-medium tracking-[0.02em] text-bone/35">
              USDC
            </span>
          </div>
        </Field>

        {destinations.length > 1 && (
          <div className="mt-6">
            <PickerLabel>Send to</PickerLabel>
            <ChainPicker
              legend="Destination chain"
              name="evm-destination-chain"
              options={destinations}
              value={destId}
              onChange={chooseDestination}
              disabled={busy}
            />
          </div>
        )}

        {fastOffered && (
          <div className="mt-6">
            <PickerLabel>Speed</PickerLabel>
            <SpeedPicker
              value={speed}
              onChange={setSpeed}
              disabled={busy}
              fastDetail={`Under a minute · ${fastFee !== null ? `+${formatUsdc6(fastFee)} USDC` : "small extra fee"}`}
              standardDetail={`${source.standardEta} · no extra fee`}
            />
          </div>
        )}

        <Field
          id="destination"
          label={`${dest.name} address`}
          className="mt-6"
          error={recipientCheck.error}
          hint="Check this carefully. A CCTP transfer cannot be reversed or refunded once signed."
        >
          <Input
            id="destination"
            spellCheck={false}
            autoComplete="off"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            placeholder={dest.evm ? "0x…" : "Recipient wallet"}
            invalid={Boolean(recipientCheck.error)}
            aria-invalid={recipientCheck.error ? "true" : undefined}
            aria-describedby={recipientCheck.error ? "destination-error" : "destination-hint"}
            className="h-14 font-mono text-sm placeholder:font-sans"
          />
        </Field>

        <UseMyWallet
          family={dest.evm ? "evm" : "solana"}
          connection={dest.evm ? connections.evm : connections.solana}
          disabled={busy}
          onUse={setRecipientInput}
          onConnect={openWallets}
        />

        {dest.evm ? (
          <ArcRecipientPanel
            address={recipientInput.trim()}
            valid={recipientCheck.ok}
            chainName={dest.name}
          />
        ) : (
          <RecipientPanel
            resolving={resolving}
            recipient={solanaRecipient}
            addressValid={recipientCheck.ok}
          />
        )}

        <EvmQuotePanel
          amount={amount}
          plan={plan}
          error={quoteError}
          sourceName={source.name}
          destinationName={dest.name}
        />

        {short && balance !== null && amount !== null && (
          <Notice tone="alarm" title="Not enough USDC" className="mt-5">
            This wallet holds <span className="tabular">{formatUsdc6(balance)}</span> USDC on{" "}
            {source.name}
            {source.id === "arc" ? (
              <>
                , of which <span className="tabular">{formatUsdc6(spendable ?? 0n)}</span> can be
                sent once gas is kept back
              </>
            ) : null}
            . This transfer needs <span className="tabular">{formatUsdc6(amount)}</span>.
          </Notice>
        )}

        {submitError && (
          <Notice tone="alarm" title="The transfer did not go through" className="mt-5">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
              {submitError}
            </pre>
            <p className="mt-2 text-bone/35">
              Nothing is burned unless a transaction hash is shown below. An approval, if you made
              one, stays in place and moves no money. Full detail is in the browser console under{" "}
              <code className="font-mono">[xebra]</code>.
            </p>
          </Notice>
        )}

        {!txHash && health?.status === "down" && (
          <Notice
            tone="alarm"
            title={`Circle is not delivering to ${dest.name} right now`}
            className="mt-5"
          >
            <p>{health.reasons[0]}</p>
            <p className="mt-1.5 text-bone/35">
              Bridging is paused so your USDC is not burned into a transfer nobody can complete.
              This page checks again every minute.
            </p>
          </Notice>
        )}
        {!txHash && health?.status === "degraded" && (
          <p className="mt-5 text-[0.75rem] leading-relaxed text-bone/40">
            {health.reasons[0]}. You can still bridge.
          </p>
        )}

        {txHash && sent && reverted ? (
          <div className="mt-6">
            <Notice tone="alarm" title={`${source.name} reverted the transfer`}>
              The transaction was mined and failed, so nothing was burned and your USDC has not left
              your wallet. The gas for it was spent.
              <p className="tabular mt-2 break-all font-mono text-[0.75rem] text-bone/40">
                {txHash}
              </p>
            </Notice>
            <Button variant="secondary" className="mt-3 w-full" onClick={startAgain}>
              Start again
            </Button>
          </div>
        ) : txHash && sent ? (
          <SubmittedNotice
            txHash={txHash}
            delivery={shownDelivery}
            destination={sent.destination}
            {...(receiptRoute ? { route: receiptRoute } : {})}
          />
        ) : (
          <>
            <Button
              size="lg"
              className="mt-6 w-full"
              disabled={Boolean(address) && (onSource ? !ready : switching)}
              onClick={!address ? connect : onSource ? bridge : switchChain}
              trailing={<ArrowRight className="h-4 w-4" />}
            >
              {!address
                ? "Connect an EVM wallet"
                : !onSource
                  ? switching
                    ? `Switching to ${source.name}…`
                    : `Switch wallet to ${source.name}`
                  : submitting
                    ? (step ?? "Working…")
                    : "Bridge USDC"}
            </Button>
            {address && onSource && !submitting && (
              <p className="mt-3 text-center text-xs text-bone/30">
                Two prompts in your wallet: an approval, then the transfer.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
