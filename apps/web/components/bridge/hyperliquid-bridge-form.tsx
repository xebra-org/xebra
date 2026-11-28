"use client";

import { type TransferStep, hyperliquidExchangeBody } from "@xebra/sdk/build";
import {
  EVM_CHAINS,
  type HyperliquidDestination,
  checkAddressOn,
  checkSolanaAddress,
  formatUsdc6,
  parseUsdcAmount,
} from "@xebra/sdk/core";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { reportError } from "../../lib/format-error";
import {
  type RememberedWithdrawal,
  type WithdrawalStatus,
  readHyperliquidBalances,
  recallHyperliquidTransfer,
  rememberHyperliquidTransfer,
  statusView,
  submitSigned,
} from "../../lib/hyperliquid/client";
import { nextPollDelay, shouldShowPollNotice } from "../../lib/poll-backoff";
import { routeDestination } from "../../lib/route-destination";
import { type UserError, fromClassified, messageError } from "../../lib/user-error";
import { classifyWalletError } from "../../lib/wallet-error";
import { parseChainId } from "../../lib/wallets/evm";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { DataRow } from "../ui/data-row";
import { ErrorNotice } from "../ui/error-notice";
import { Field, Input } from "../ui/field";
import { InsetTray } from "../ui/glass-card";
import { ArrowRight, ArrowUpRight, Check } from "../ui/icons";
import { Notice } from "../ui/notice";
import { Skeleton } from "../ui/skeleton";
import { StripeRule } from "../ui/stripe-rule";
import { useWallets } from "../wallet/wallet-provider";
import { CHAIN_NAMES } from "./chain-glyph";
import { ChainPicker, PickerLabel } from "./chain-picker";
import { CopyButton } from "./receipt";

/**
 * A withdrawal from Hyperliquid (HyperCore), straight to another chain through Circle.
 *
 * The person signs two gas-free Hyperliquid messages in the wallet they trade with: the withdrawal
 * (`sendToEvmWithData`, which Circle burns on HyperEVM and delivers) and Xebra's fee (a USDC send on
 * Hyperliquid). Both are signed before either is sent, so declining either sends nothing. The page
 * then posts them to Hyperliquid, withdrawal first, and follows the withdrawal through Xebra's
 * `/v1` status until it lands. Prices, both messages and the status all come from `/v1`; the
 * browser only reads the balance and posts what was signed.
 *
 * Hyperliquid's own Withdraw button sends USDC to Arbitrum, Base, Ethereum and Polygon
 * (docs/hyperliquid-withdraw.md), so the copy leads with the chains it cannot reach.
 */

export interface HyperliquidSourceConfig {
  available: boolean;
  /** Why it is unavailable, in a sentence. */
  reason: string | null;
  destinations: HyperliquidDestination[];
  maxUsdc: string | null;
}

/** `/v1/quote`'s answer, as far as this form reads it. */
interface WireQuote {
  amount: string;
  recipientGets: string;
  fees: { xebra: string; delivery: string; activation?: string; total: string };
  minimum: string;
}

const POLL_MS = 4_000;
const BALANCE_MS = 30_000;
const QUOTE_DEBOUNCE_MS = 350;
/** Arbitrum: what Circle's and Hyperliquid's own examples sign with when a wallet will not say. */
const DEFAULT_SIGNATURE_CHAIN = 42161;

const nameOf = (d: HyperliquidDestination) => CHAIN_NAMES[d];
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const units = (s: string) => (/^0+(\.0+)?$/.test(s) ? 0n : parseUsdcAmount(s));

async function problemDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof body?.detail === "string"
    ? body.detail
    : "Xebra could not be reached just now. Nothing was sent. Try again shortly.";
}

/** Asks the wallet to sign one Hyperliquid message. */
async function signTyped(
  provider: { request(a: { method: string; params?: unknown[] }): Promise<unknown> },
  address: string,
  step: TransferStep,
): Promise<string> {
  if (step.tx.kind !== "hyperliquid") throw new Error("not a Hyperliquid step");
  const sig = await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(step.tx.typedData)],
  });
  if (typeof sig !== "string") throw new Error("The wallet returned no signature.");
  return sig;
}

export function HyperliquidBridgeForm({
  config,
  sourcePicker,
  onBusyChange,
}: {
  config: HyperliquidSourceConfig;
  sourcePicker?: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { connections, open: openWallets } = useWallets();
  const wallet = connections.evm ?? null;
  const address = wallet?.address ?? null;
  const provider = wallet?.provider ?? null;

  const [to, setTo] = useState<HyperliquidDestination>(
    // Solana first: the chain Hyperliquid's own button cannot send USDC to that people ask for most.
    config.destinations.includes("solana") ? "solana" : (config.destinations[0] ?? "arc"),
  );
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<
    "idle" | "preparing" | "sign-withdrawal" | "sign-fee" | "sending"
  >("idle");
  const [error, setError] = useState<UserError | null>(null);
  const [sent, setSent] = useState<RememberedWithdrawal | null>(null);
  const [saved, setSaved] = useState(true);
  const [unheard, setUnheard] = useState(false);

  useEffect(() => {
    const r = recallHyperliquidTransfer();
    if (r) setSent(r);
  }, []);

  // The Hyperliquid balance of the connected wallet, read straight from Hyperliquid.
  const [balances, setBalances] = useState<{ perps: bigint; spot: bigint } | null | undefined>();
  useEffect(() => {
    if (!address) {
      setBalances(undefined);
      return;
    }
    let live = true;
    const load = async () => {
      const b = await readHyperliquidBalances(address);
      if (live) setBalances(b);
    };
    void load();
    const t = setInterval(load, BALANCE_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [address]);

  const evm = to !== "solana" ? EVM_CHAINS[to] : null;
  const amountUnits = parseUsdcAmount(amount.trim());
  const recipientCheck = useMemo(() => {
    const r = recipient.trim();
    if (r === "") return { ok: false as const, error: null };
    const c = evm ? checkAddressOn(evm, r) : checkSolanaAddress(r);
    return c.ok
      ? { ok: true as const, error: null }
      : { ok: false as const, error: c.error ?? "That address is not one this chain takes." };
  }, [recipient, evm]);

  // Xebra's price for this amount and account, asked again as the inputs settle.
  const [quote, setQuote] = useState<{
    key: string;
    value: WireQuote | null;
    error: string | null;
  }>();
  const quoteKey = `${to}:${amountUnits ?? ""}:${address ?? ""}`;
  useEffect(() => {
    if (sent || amountUnits === null || !config.available) return;
    let live = true;
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ from: "hyperliquid", to, amount: amount.trim() });
      if (address) q.set("sender", address);
      try {
        const res = await fetch(`/v1/quote?${q}`, { cache: "no-store" });
        const value = res.ok ? ((await res.json()) as WireQuote) : null;
        const err = res.ok ? null : await problemDetail(res);
        if (live) setQuote({ key: quoteKey, value, error: err });
      } catch {
        if (live) {
          setQuote({
            key: quoteKey,
            value: null,
            error: "Xebra could not be reached just now, so there is no price yet.",
          });
        }
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [quoteKey, sent, amountUnits, to, amount, address, config.available]);
  const current = quote?.key === quoteKey ? quote : null;

  const total = balances ? balances.perps + balances.spot : null;
  const overBalance = amountUnits !== null && total !== null && amountUnits > total;
  const capUnits = config.maxUsdc !== null ? parseUsdcAmount(config.maxUsdc) : null;
  const overCap = amountUnits !== null && capUnits !== null && amountUnits > capUnits;
  const amountError = overCap
    ? `The limit is ${config.maxUsdc} USDC per withdrawal for now.`
    : overBalance && total !== null
      ? `Your Hyperliquid account can withdraw ${formatUsdc6(total)} USDC right now.`
      : null;

  const canSend =
    config.available &&
    Boolean(provider && address) &&
    amountUnits !== null &&
    !overCap &&
    !overBalance &&
    recipientCheck.ok &&
    current?.value != null &&
    step === "idle";

  const send = useCallback(async () => {
    if (!provider || !address || amountUnits === null || !current?.value) return;
    setError(null);
    setUnheard(false);
    setStep("preparing");
    // Set once a signed withdrawal may have reached Hyperliquid: only then can money have moved.
    let posted = false;
    try {
      const chainId =
        wallet?.chainId ??
        parseChainId(await provider.request({ method: "eth_chainId" }).catch(() => undefined)) ??
        DEFAULT_SIGNATURE_CHAIN;
      const res = await fetch("/v1/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "hyperliquid",
          to,
          amount: amount.trim(),
          sender: address,
          recipient: recipient.trim(),
          maxTotalFee: current.value.fees.total,
          signatureChainId: chainId,
        }),
      });
      if (!res.ok) {
        const detail = await problemDetail(res);
        setError(messageError(detail, { title: "The withdrawal wasn't started" }));
        return;
      }
      const built = (await res.json()) as { steps?: TransferStep[] };
      const [withdrawal, fee] = built.steps ?? [];
      if (
        withdrawal?.id !== "burn" ||
        withdrawal.tx.kind !== "hyperliquid" ||
        fee?.id !== "fee" ||
        fee.tx.kind !== "hyperliquid" ||
        withdrawal.tx.typedData.domain.chainId !== chainId
      ) {
        setError(
          messageError(
            "Xebra sent back something this page does not recognise. Nothing was sent.",
            {
              title: "The withdrawal wasn't started",
            },
          ),
        );
        return;
      }

      // Both signatures first: declining either one sends nothing at all.
      let sigWithdrawal: string;
      let sigFee: string;
      try {
        setStep("sign-withdrawal");
        sigWithdrawal = await signTyped(provider, address, withdrawal);
        setStep("sign-fee");
        sigFee = await signTyped(provider, address, fee);
      } catch (err) {
        const c = classifyWalletError(err);
        reportError("hyperliquid signature failed", c.raw);
        setError(
          fromClassified(
            { ...c, maybeSent: false },
            { wallet: wallet?.walletName, chain: "Hyperliquid" },
          ),
        );
        return;
      }

      setStep("sending");
      posted = true;
      const outcome = await submitSigned(
        withdrawal.tx.exchangeUrl,
        hyperliquidExchangeBody(withdrawal.tx, sigWithdrawal),
      );
      if (!outcome.ok && outcome.refused) {
        posted = false;
        setError(messageError(outcome.message, { title: "Hyperliquid refused the withdrawal" }));
        return;
      }
      // The withdrawal is out (or may be). Xebra's fee follows; if it fails, the withdrawal stands.
      if (outcome.ok) {
        const paid = await submitSigned(
          fee.tx.exchangeUrl,
          hyperliquidExchangeBody(fee.tx, sigFee),
        );
        if (!paid.ok) reportError("xebra hyperliquid fee not sent", paid.message);
      } else {
        setUnheard(true);
      }
      const id = `${address.toLowerCase()}:${withdrawal.tx.nonce}`;
      const r: RememberedWithdrawal = { id, to, at: Date.now() };
      setSaved(rememberHyperliquidTransfer(r));
      setSent(r);
    } catch (err) {
      reportError("hyperliquid withdrawal failed", err);
      setError(
        posted
          ? {
              tone: "alarm",
              title: "We lost track of the withdrawal",
              body: "It may have reached Hyperliquid.",
              steps: [
                "Check your Hyperliquid balance and its history before sending again.",
                "If the USDC left, it is on its way through Circle.",
              ],
              funds: "uncertain",
              detail: "",
            }
          : messageError("Xebra could not prepare the withdrawal. Nothing was sent. Try again.", {
              title: "The withdrawal wasn't started",
            }),
      );
    } finally {
      setStep("idle");
    }
  }, [provider, address, amountUnits, current, wallet, to, amount, recipient]);

  const busy = step !== "idle" || sent !== null;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function startOver() {
    rememberHyperliquidTransfer(null);
    setSent(null);
    setSaved(true);
    setUnheard(false);
    setError(null);
    setAmount("");
  }

  const count = config.destinations.length;
  const intro = (
    <Notice tone="info" title={`Out of Hyperliquid, straight to ${count} chains`} className="mb-6">
      <p className="max-w-[60ch] text-pretty">
        Solana, Arc, Avalanche, OP Mainnet, Monad and the rest, in Circle&rsquo;s own USDC.
        Hyperliquid&rsquo;s Withdraw button only reaches Arbitrum, Base, Ethereum and Polygon. Two
        gas-free signatures, no bridge in between.
      </p>
      <p className="mt-2 text-bone/45">
        New route on mainnet
        {config.maxUsdc !== null ? `, up to ${config.maxUsdc} USDC per withdrawal` : ""}. Check the
        recipient twice: Circle mints only to the address you enter.
      </p>
    </Notice>
  );

  let body: React.ReactNode;
  if (!config.available) {
    body = (
      <Notice tone="info" title="Withdrawals from Hyperliquid are not open yet">
        {config.reason ?? "This route is switched off for now."} Your USDC stays on Hyperliquid
        until you move it.
      </Notice>
    );
  } else if (sent) {
    body = <Tracking sent={sent} saved={saved} unheard={unheard} onReset={startOver} />;
  } else {
    const label =
      step === "preparing"
        ? "Preparing"
        : step === "sign-withdrawal"
          ? "Sign the withdrawal (1 of 2)"
          : step === "sign-fee"
            ? "Sign Xebra's fee (2 of 2)"
            : step === "sending"
              ? "Sending to Hyperliquid"
              : "Withdraw from Hyperliquid";
    body = (
      <div className="flex flex-col gap-6">
        {address ? (
          <BalanceLine address={address} balances={balances} />
        ) : (
          <Notice tone="info" title="Connect the wallet you trade with on Hyperliquid">
            MetaMask, Rabby or any EVM wallet. It signs two messages; nothing is paid in gas. An API
            or agent wallet cannot withdraw: use your main one.
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => openWallets(["evm"])}>
                Connect a wallet
              </Button>
            </div>
          </Notice>
        )}

        <div>
          <PickerLabel>Send to</PickerLabel>
          <ChainPicker<HyperliquidDestination>
            legend="Destination chain"
            name="hyperliquid-destination"
            options={config.destinations.map((id) => ({ id, name: nameOf(id) }))}
            value={to}
            onChange={(id) => {
              setError(null);
              // An address for one kind of chain is never right for another.
              if ((id === "solana") !== (to === "solana")) setRecipient("");
              setTo(id);
            }}
            disabled={step !== "idle"}
          />
          <p className="mt-3 max-w-[60ch] text-xs leading-relaxed text-bone/35">
            Sending to Stellar? Not straight from Hyperliquid yet: USDC sent there this way would be
            stuck for good. Withdraw to Base, then send from Base to Stellar here.
          </p>
        </div>

        <Field
          id="hyperliquid-amount"
          label="Amount"
          hint="Everything that leaves your Hyperliquid balance, fees included."
          error={amount.trim() !== "" ? amountError : null}
          trailing={<span className="text-xs text-bone/35">USDC</span>}
        >
          <Input
            id="hyperliquid-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            placeholder="0.00"
            className="tabular h-12 text-base"
            invalid={amount.trim() !== "" && (amountUnits === null || amountError !== null)}
          />
        </Field>

        <Field
          id="hyperliquid-recipient"
          label={`${nameOf(to)} address`}
          hint={
            to === "solana"
              ? "The wallet that receives USDC on Solana. Circle opens its USDC account if needed; you need no SOL."
              : `The wallet that receives USDC on ${nameOf(to)}. Circle delivers it; you need no ${evm?.nativeCurrency.symbol ?? "gas"}.`
          }
          error={recipientCheck.error}
        >
          <Input
            id="hyperliquid-recipient"
            autoComplete="off"
            spellCheck={false}
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setError(null);
            }}
            placeholder={to === "solana" ? "Recipient wallet" : "0x…"}
            className="h-12 font-mono text-xs"
            invalid={recipientCheck.error !== null}
          />
        </Field>
        {address && to !== "solana" && recipient.trim() === "" && (
          <button
            type="button"
            onClick={() => setRecipient(address)}
            className="-mt-4 self-start text-xs text-bone/45 underline decoration-bone/20 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50"
          >
            Send to my own address on {nameOf(to)} ({short(address)})
          </button>
        )}

        {amountUnits !== null && (
          <div className="-mt-2">
            <QuotePanel quote={current} destination={nameOf(to)} />
          </div>
        )}

        {error && <ErrorNotice error={error} />}

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
        Withdraw USDC from Hyperliquid to {nameOf(to)}
      </h2>
      <div className="px-5 py-6 sm:px-6">
        {sourcePicker}
        {!sent && intro}
        {body}
      </div>
    </>
  );
}

function BalanceLine({
  address,
  balances,
}: {
  address: string;
  balances: { perps: bigint; spot: bigint } | null | undefined;
}) {
  return (
    <InsetTray>
      <dl className="tabular space-y-2.5">
        <DataRow
          label="On Hyperliquid"
          value={
            balances === undefined ? (
              <Skeleton className="h-3 w-20" />
            ) : balances === null ? (
              "—"
            ) : (
              `${formatUsdc6(balances.perps + balances.spot)} USDC`
            )
          }
          hint={
            balances === null
              ? "Hyperliquid could not be read just now. This page asks again."
              : balances
                ? `Perps ${formatUsdc6(balances.perps)} · Spot ${formatUsdc6(balances.spot)}, for ${short(address)}. A withdrawal leaves one of them, whole.`
                : `For ${short(address)}.`
          }
        />
      </dl>
    </InsetTray>
  );
}

function QuotePanel({
  quote,
  destination,
}: {
  quote: { value: WireQuote | null; error: string | null } | null;
  destination: string;
}) {
  if (quote?.error) {
    return (
      <Notice tone="alarm" title="This withdrawal can't be priced">
        {quote.error}
      </Notice>
    );
  }
  const q = quote?.value;
  if (!q) {
    return (
      <InsetTray className="space-y-3.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className={cn("h-3", i === 2 ? "w-28" : "w-20")} />
            <Skeleton className={cn("h-3", i === 2 ? "w-24" : "w-16")} />
          </div>
        ))}
      </InsetTray>
    );
  }
  const activation = q.fees.activation ? units(q.fees.activation) : 0n;
  return (
    <InsetTray>
      <dl className="tabular space-y-3">
        <DataRow label="Leaves Hyperliquid" value={`${q.amount} USDC`} />
        <DataRow
          label="Delivery"
          value={`−${q.fees.delivery} USDC`}
          hint={`Circle's fee to mint it on ${destination} for you, set by Circle's Hyperliquid contract.`}
        />
        {activation !== null && activation > 0n && (
          <DataRow
            label="First withdrawal"
            value={`−${q.fees.activation} USDC`}
            hint="Hyperliquid's one-time fee on an account's first withdrawal. Never again after this."
          />
        )}
        <DataRow
          label="Xebra fee"
          value={`−${q.fees.xebra} USDC`}
          hint="0.01% plus 0.01 USDC, the second message you sign."
        />
        <div className="pt-3">
          <StripeRule className="mb-3 opacity-50" />
          <DataRow
            label="Recipient gets"
            value={`${q.recipientGets} USDC`}
            emphasis
            hint="After every fee."
          />
        </div>
      </dl>
    </InsetTray>
  );
}

const STEPS = ["Hyperliquid hands it to Circle", "Circle burns and delivers it", "Arrived"];

/** A withdrawal on its way, followed through `/v1` until it lands. */
function Tracking({
  sent,
  saved,
  unheard,
  onReset,
}: {
  sent: RememberedWithdrawal;
  saved: boolean;
  unheard: boolean;
  onReset: () => void;
}) {
  const [status, setStatus] = useState<WithdrawalStatus | null>(null);
  const [pollError, setPollError] = useState(false);
  const view = status ? statusView(status) : null;
  const dest = routeDestination(sent.to);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/v1/transfers/hyperliquid/${encodeURIComponent(sent.id)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as WithdrawalStatus;
        if (cancelled) return;
        failures = 0;
        setPollError(false);
        setStatus(s);
        if (s.state === "delivered") {
          rememberHyperliquidTransfer(null);
          return;
        }
      } catch {
        if (cancelled) return;
        failures += 1;
        if (shouldShowPollNotice(failures)) setPollError(true);
      }
      if (!cancelled) timer = setTimeout(tick, nextPollDelay(failures, POLL_MS));
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sent.id]);

  const step = view?.step ?? 1;
  return (
    <div className="flex flex-col gap-5">
      {unheard && (
        <Notice tone="info" title="We didn't hear back from Hyperliquid">
          The withdrawal may or may not have gone through. This page watches for it; check your
          Hyperliquid balance before sending again.
        </Notice>
      )}
      {pollError && (
        <Notice tone="info" title="We can't reach the status service right now">
          Your withdrawal is safe; this page keeps trying.
        </Notice>
      )}

      <InsetTray>
        <ol className="space-y-3.5">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = view?.done || n < step;
            const active = !view?.done && n === step;
            return (
              <li key={label} className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] ring-1 transition-colors duration-300",
                    done
                      ? "bg-signal/15 text-signal ring-signal/30"
                      : active
                        ? "text-bone ring-bone/40"
                        : "text-bone/30 ring-bone/10",
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : n}
                </span>
                <span className={done ? "text-bone/70" : active ? "text-bone/90" : "text-bone/35"}>
                  {n === 3 && dest ? `Arrived on ${dest.name}` : label}
                </span>
              </li>
            );
          })}
        </ol>
        {view?.note && !view.done && (
          <p className="mt-4 max-w-[60ch] text-xs leading-relaxed text-bone/45">{view.note}</p>
        )}
      </InsetTray>

      {view?.problem && (
        <Notice tone="alarm" title="Circle couldn't deliver it">
          <p className="max-w-[60ch] text-pretty">{view.problem}</p>
          {view.claimUrl && (
            <a
              href={view.claimUrl}
              className="mt-3 inline-flex items-center gap-1 text-bone underline decoration-bone/25 underline-offset-[3px] hover:decoration-bone/50"
            >
              Open the claim page <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          )}
        </Notice>
      )}

      {view?.done && status?.deliveryTx && dest && (
        <a
          href={dest.explorerTxUrl(status.deliveryTx)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 self-start text-sm text-bone/70 underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone"
        >
          See it on {dest.name} <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      )}

      <div className="flex items-center justify-between gap-3">
        {!view?.done &&
          (saved ? (
            <p className="max-w-[18rem] text-xs leading-relaxed text-bone/35">
              Safe to close this tab. Come back on the same browser and it picks up where it left
              off.
            </p>
          ) : (
            <p className="max-w-[20rem] text-xs leading-relaxed text-bone/45">
              This browser could not save your withdrawal. Keep this to find it again:{" "}
              <span className="tabular font-mono text-bone/70">{short(sent.id)}</span>{" "}
              <CopyButton value={sent.id} label="withdrawal id" />
            </p>
          ))}
        <Button
          variant={view?.done ? "primary" : "quiet"}
          size="sm"
          onClick={onReset}
          className={view?.done ? "ml-auto" : ""}
        >
          {view?.done ? "Withdraw again" : "Start over"}
        </Button>
      </div>
    </div>
  );
}
