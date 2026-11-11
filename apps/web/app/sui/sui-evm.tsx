"use client";

import type { WalletAccount } from "@wallet-standard/base";
import type { CircleHealth } from "@xebra/cctp-client";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { type Chain, ChainGlyph } from "../../components/bridge/chain-glyph";
import { EvmQuotePanel } from "../../components/bridge/evm-quote-panel";
import { SubmittedNotice } from "../../components/bridge/receipt";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { Field, Input } from "../../components/ui/field";
import { ArrowRight } from "../../components/ui/icons";
import { Notice } from "../../components/ui/notice";
import { type DeliveryView, getDelivery, getRouteHealth } from "../../lib/circle-status";
import { checkAddressOn } from "../../lib/evm-address";
import { EVM_CHAINS, type EvmChain, type EvmChainId, explorerTxUrl } from "../../lib/evm-chains";
import { type FeePlan, planEvmFee } from "../../lib/evm-forward-fee";
import { reportError } from "../../lib/format-error";
import { type SuiWalletEntry, signAndExecuteSui } from "../../lib/wallets/sui";

/**
 * Sui to an EVM chain (Monad first): burn on Sui and Circle's Forwarding Service mints on the
 * destination. Unlike Sui to Stellar nothing of ours finishes the transfer, so there is no relayer
 * and no claim on this page; a delivery that fails is claimed at `/claim`, like any EVM-bound one.
 *
 * The fee is Circle's delivery fee only, priced with the same rules as every direct EVM route
 * (`planEvmFee`), and the server prices it again before building the burn.
 */

const SUI_DOMAIN = 8;
const STORAGE_KEY = "xebra.sui-evm.transfer";
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const POLL_MS = 5000;
const HEALTH_MS = 30_000;
/**
 * How long Circle is given to pick up an attested burn before it is called claimable: Iris can show
 * the attestation a moment before it shows the delivery under way (as in `evm-bridge-form.tsx`).
 */
const CLAIM_GRACE_MS = 10 * 60_000;

export type SuiDestination = "stellar" | EvmChainId;

interface Remembered {
  digest: string;
  chain: EvmChainId;
  /** When it was burned, for the claim grace. */
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

/** The Sui to EVM transfer this browser was following, if any. */
export function recallSuiEvm(): Remembered | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    return typeof v.digest === "string" && DIGEST.test(v.digest) && typeof v.chain === "string"
      ? { digest: v.digest, chain: v.chain as EvmChainId, at: typeof v.at === "number" ? v.at : 0 }
      : null;
  } catch {
    return null;
  }
}

/** "Send to": Stellar, or one of the EVM chains the server lets Sui send to. */
export function SuiDestinationPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: SuiDestination;
  options: readonly SuiDestination[];
  onChange: (d: SuiDestination) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0 disabled:opacity-50">
      <legend className="mb-2.5 text-eyebrow font-medium uppercase text-bone/40">Send to</legend>
      <div
        className={cn(
          "grid gap-1 rounded-tray bg-obsidian-sunken p-1 ring-1 ring-inset ring-bone/[0.06]",
          options.length === 2 ? "grid-cols-2" : "grid-cols-3",
        )}
      >
        {options.map((id) => {
          const chosen = id === value;
          const name = id === "stellar" ? "Stellar" : EVM_CHAINS[id].name;
          return (
            <label
              key={id}
              className="relative block min-w-0 cursor-pointer has-[:disabled]:cursor-not-allowed"
            >
              <input
                type="radio"
                name="sui-destination"
                value={id}
                checked={chosen}
                onChange={() => onChange(id)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex items-center gap-2.5 rounded-[0.875rem] px-3.5 py-2.5",
                  "transition-colors duration-400 ease-haptic active:scale-[0.99]",
                  "peer-focus-visible:ring-1 peer-focus-visible:ring-bone/40",
                  chosen ? "bg-bone/[0.1]" : "hover:bg-bone/[0.04]",
                )}
              >
                <ChainGlyph chain={id as Chain} className={chosen ? "" : "opacity-60"} />
                <span
                  className={cn(
                    "truncate text-sm font-medium tracking-[-0.01em]",
                    chosen ? "text-bone" : "text-bone/45",
                  )}
                >
                  {name}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function parseAmount(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const v = BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return v > 0n ? v : null;
}

/**
 * The form and, once burned, the receipt. `walletSection` and `picker` belong to the Sui transfer
 * around it, so switching between Stellar and an EVM chain keeps the connected wallet.
 */
export function SuiToEvm({
  chain,
  wallet,
  account,
  maxUsdc,
  walletSection,
  picker,
  onBusyChange,
}: {
  chain: EvmChain;
  wallet: SuiWalletEntry | null;
  account: WalletAccount | null;
  maxUsdc: string | null;
  walletSection: React.ReactNode;
  picker: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [health, setHealth] = useState<CircleHealth | null>(null);
  const [step, setStep] = useState<"idle" | "preparing" | "signing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);

  // A transfer to this chain that this browser was following comes back on screen.
  useEffect(() => {
    const r = recallSuiEvm();
    if (r && r.chain === chain.id) {
      setDigest(r.digest);
      setSentAt(r.at);
    }
  }, [chain.id]);

  const delivered = delivery?.status === "known" && delivery.state === "delivered";
  useEffect(() => {
    onBusyChange?.(step !== "idle" || (digest !== null && !delivered));
  }, [onBusyChange, step, digest, delivered]);

  // Circle's quote for Sui to this chain, refreshed while the form is open.
  useEffect(() => {
    if (digest) return;
    let cancelled = false;
    const load = async () => {
      const h = await getRouteHealth(SUI_DOMAIN, chain.cctpDomainId);
      if (!cancelled) setHealth(h);
    };
    void load();
    const t = setInterval(load, HEALTH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [chain.cctpDomainId, digest]);

  // Follow the burn until Circle has delivered it (or says it could not).
  useEffect(() => {
    if (!digest) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await getDelivery(digest, SUI_DOMAIN);
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
  }, [digest]);

  const units = parseAmount(amount);
  const address = checkAddressOn(chain, recipient);
  const tier = health?.tiers.standard ?? null;
  const plan: FeePlan | null = useMemo(
    () => (units !== null && tier ? planEvmFee({ amount: units, tier, destination: chain }) : null),
    [units, tier, chain],
  );
  const routeDown = health?.status === "down" || (health !== null && !tier);
  const quoteError = routeDown
    ? `Circle cannot deliver from Sui to ${chain.name} right now${health?.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing has been burned. Try again shortly.`
    : plan && !plan.ok && plan.kind === "cap"
      ? plan.reason
      : null;
  const amountError = plan && !plan.ok && plan.kind !== "cap" ? plan.reason : null;

  const canSend =
    Boolean(wallet && account) && address.ok && plan?.ok === true && !routeDown && step === "idle";

  async function send() {
    if (!wallet || !account || !plan?.ok) return;
    setError(null);
    setStep("preparing");
    try {
      const res = await fetch("/api/sui-evm/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender: account.address,
          amount: amount.trim(),
          recipient: recipient.trim(),
          chain: chain.id,
          maxFee: plan.maxFee.toString(),
        }),
      });
      const body = (await res.json()) as { transaction?: string; error?: string };
      if (!res.ok || !body.transaction) {
        setError(body.error ?? "Could not prepare the transfer.");
        // A fee that moved is shown again from a fresh quote before anything is signed.
        if (res.status === 409) setHealth(await getRouteHealth(SUI_DOMAIN, chain.cctpDomainId));
        return;
      }
      setStep("signing");
      const tx = await signAndExecuteSui(wallet, account, body.transaction);
      const at = Date.now();
      remember({ digest: tx, chain: chain.id, at });
      setSentAt(at);
      setDelivery(null);
      setDigest(tx);
    } catch (err) {
      setError(reportError("sui burn to evm failed", err));
    } finally {
      setStep("idle");
    }
  }

  function startOver() {
    remember(null);
    setDigest(null);
    setDelivery(null);
    setError(null);
    setAmount("");
  }

  if (digest) {
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
          txHash={digest}
          delivery={shown}
          destination={{
            name: chain.name,
            explorerTxUrl: (hash) => explorerTxUrl(chain, hash),
            claimCost: chain.claimCost,
          }}
          route={{
            eta: "This usually takes a few minutes.",
            burnUrl: `https://suivision.xyz/txblock/${digest}`,
            claimHref: `/claim?tx=${encodeURIComponent(digest)}&src=${SUI_DOMAIN}`,
          }}
        />
        <div className="flex items-center justify-between gap-3">
          {!delivered && (
            <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
              Safe to close this tab. Come back on the same browser and it picks up where it left
              off.
            </p>
          )}
          <Button
            variant={delivered ? "primary" : "quiet"}
            size="sm"
            onClick={startOver}
            className={delivered ? "ml-auto" : ""}
          >
            {delivered ? "Send another" : "Start over"}
          </Button>
        </div>
      </div>
    );
  }

  const label =
    step === "preparing"
      ? "Preparing"
      : step === "signing"
        ? "Confirm in your wallet"
        : "Burn on Sui";

  return (
    <div className="flex flex-col gap-6">
      {walletSection}
      {picker}

      <Field
        id="sui-evm-amount"
        label="Amount"
        hint={maxUsdc !== null ? `USDC on Sui. Up to ${maxUsdc} per transfer.` : "USDC on Sui."}
        error={amount.trim() !== "" ? amountError : null}
        trailing={<span className="text-xs text-bone/35">USDC</span>}
      >
        <Input
          id="sui-evm-amount"
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
        id="sui-evm-recipient"
        label={`${chain.name} address`}
        hint={`The wallet that receives USDC on ${chain.name}. Circle delivers it; you need no ${chain.nativeCurrency.symbol}.`}
        error={recipient.trim() !== "" && !address.ok ? (address.error ?? null) : null}
      >
        <Input
          id="sui-evm-recipient"
          autoComplete="off"
          spellCheck={false}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x…"
          className="h-12 font-mono text-xs"
          invalid={recipient.trim() !== "" && !address.ok}
        />
      </Field>

      {(units !== null || quoteError) && (
        <div className="-mt-6">
          <EvmQuotePanel
            amount={units}
            plan={plan}
            error={quoteError}
            sourceName="Sui"
            destinationName={chain.name}
          />
        </div>
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
  );
}
