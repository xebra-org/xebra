"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { DataRow } from "../../components/ui/data-row";
import { Field, Input } from "../../components/ui/field";
import { GlassCard, InsetTray } from "../../components/ui/glass-card";
import { ArrowRight, ArrowUpRight, Check } from "../../components/ui/icons";
import { Notice } from "../../components/ui/notice";
import { Skeleton } from "../../components/ui/skeleton";
import { useWallets } from "../../components/wallet/wallet-provider";
import { env } from "../../lib/env";
import { reportError } from "../../lib/format-error";

/**
 * Stellar USDC into anything NEAR Intents delivers, with Xebra carrying the USDC.
 *
 * NEAR Intents' solvers do not quote Stellar USDC today, so a Stellar wallet cannot swap through
 * Intents directly. Xebra moves the USDC over Circle's CCTP to Base, straight into the deposit
 * address NEAR Intents issues, and Intents does the rest. The page prices both paths side by side
 * from live quotes, then asks for one signature on Stellar.
 */

interface Destination {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  recipientHint: string;
}

interface PathPrice {
  available: boolean;
  reason?: string;
  amountOut?: string;
  amountOutUsd?: string;
  timeEstimate?: number;
}

interface XebraQuote {
  recipientGets: string;
  fees: { xebra: string; circle: string; delivery: string; total: string };
}

interface Comparison {
  direct: PathPrice;
  viaXebra: PathPrice & { hub?: string; xebra?: XebraQuote };
}

interface Tracked {
  depositAddress: string;
  tx: string;
  hub: string;
  expectOut: string;
  symbol: string;
}

interface Status {
  xebra: { state: string; deliveryTx: string | null } | null;
  intents: {
    status: string;
    swapDetails?: {
      amountOutFormatted?: string;
      destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
      refundedAmountFormatted?: string;
    };
  } | null;
}

const STORAGE_KEY = "xebra.near-intents.tracked";
const HUB_NAME: Record<string, string> = { base: "Base", arbitrum: "Arbitrum", solana: "Solana" };

function remember(t: Tracked | null) {
  try {
    if (t) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the swap still runs, it just cannot be resumed after a reload.
  }
}

function recall(): Tracked | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Tracked) : null;
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const minutes = (s: number | undefined) =>
  s === undefined ? "-" : s < 90 ? `about ${Math.round(s)} s` : `about ${Math.round(s / 60)} min`;

export function NearIntentsClient() {
  const { connections, stellarKit: kit, open } = useWallets();
  const sender = connections.stellar?.address ?? null;

  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [destError, setDestError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState("");
  const [amount, setAmount] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "submitting">("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<Tracked | null>(null);

  useEffect(() => {
    setTracked(recall());
    fetch("/api/near-intents/destinations")
      .then((r) => r.json() as Promise<{ destinations?: Destination[]; error?: string }>)
      .then((j) => {
        if (!j.destinations) throw new Error(j.error ?? "No destinations");
        setDestinations(j.destinations);
        setAssetId((cur) => cur || (j.destinations?.[0]?.assetId ?? ""));
      })
      .catch((e) => setDestError(reportError("NEAR Intents' token list", e)));
  }, []);

  const destination = destinations?.find((d) => d.assetId === assetId) ?? null;

  // Re-price shortly after the inputs settle. A Stellar address stands in for the sender until a
  // wallet is connected: pricing does not depend on who sends.
  const ticket = useRef(0);
  useEffect(() => {
    setComparison(null);
    setPriceError(null);
    if (!destination || !recipient.trim() || !/^\d+(\.\d{1,6})?$/.test(amount.trim())) return;
    const id = ++ticket.current;
    const t = setTimeout(() => {
      setPricing(true);
      post<Comparison>("/api/near-intents/compare", {
        amount: amount.trim(),
        sender: sender ?? "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L",
        destinationAsset: destination.assetId,
        recipient: recipient.trim(),
      })
        .then((c) => id === ticket.current && setComparison(c))
        .catch((e) => id === ticket.current && setPriceError(reportError("The quote", e)))
        .finally(() => id === ticket.current && setPricing(false));
    }, 600);
    return () => clearTimeout(t);
  }, [amount, recipient, destination, sender]);

  // Each press gets a number. Cancelling bumps it, so a wallet or network answer that arrives
  // after the person gave up is ignored instead of yanking the page into a transfer they left.
  const attempt = useRef(0);

  const cancel = useCallback(() => {
    attempt.current += 1;
    setStep("idle");
    setSendError("Cancelled. Nothing was sent: no transaction reached Stellar.");
  }, []);

  const send = useCallback(async () => {
    if (!kit || !sender || !destination) return;
    const mine = ++attempt.current;
    const live = () => mine === attempt.current;
    setSendError(null);
    try {
      setStep("preparing");
      console.info("[xebra] near-intents: asking NEAR Intents for a deposit address");
      const prepared = await withTimeout(
        post<{
          hub: string;
          depositAddress: string;
          intents: { amountOutFormatted: string };
          build: { steps: { tx: { kind: string; xdr?: string; networkPassphrase?: string } }[] };
        }>("/api/near-intents/prepare", {
          amount: amount.trim(),
          sender,
          destinationAsset: destination.assetId,
          recipient: recipient.trim(),
        }),
        60_000,
        "NEAR Intents took too long to issue a deposit address. Nothing was sent; try again.",
      );
      if (!live()) return;
      const tx = prepared.build.steps[0]?.tx;
      if (prepared.build.steps.length !== 1 || tx?.kind !== "stellar" || !tx.xdr) {
        throw new Error("Expected a single Stellar transaction to sign.");
      }
      console.info("[xebra] near-intents: deposit address", prepared.depositAddress);

      setStep("signing");
      const passphrase = tx.networkPassphrase ?? env.stellarNetworkPassphrase;
      const { signedTxXdr } = await kit.signTransaction(tx.xdr, {
        networkPassphrase: passphrase,
        address: sender,
      });
      if (!live()) return;
      console.info("[xebra] near-intents: signed, submitting to Stellar");

      setStep("submitting");
      // Submitted by our server, which retries a failed connection; the browser's own link to
      // Stellar's RPC is the part that dropped signed transfers with "Network Error".
      const { txHash } = await withTimeout(
        post<{ txHash: string }>("/api/near-intents/submit", { xdr: signedTxXdr }),
        90_000,
        "Stellar's network did not answer in time. Check your wallet's activity before trying again: if the transaction shows there, it went through.",
      );
      if (!live()) return;
      console.info("[xebra] near-intents: submitted", txHash);
      const t: Tracked = {
        depositAddress: prepared.depositAddress,
        tx: txHash,
        hub: prepared.hub,
        expectOut: prepared.intents.amountOutFormatted,
        symbol: destination.symbol,
      };
      remember(t);
      setTracked(t);
    } catch (e) {
      if (live()) setSendError(reportError("The transfer", e));
    } finally {
      if (live()) setStep("idle");
    }
  }, [kit, sender, destination, amount, recipient]);

  const busy = step !== "idle";
  const via = comparison?.viaXebra;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-14 sm:px-5 sm:py-20">
      <header className="max-w-2xl px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance] sm:text-3xl">
          Stellar USDC into NEAR Intents
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-bone/55">
          NEAR Intents can swap into almost anything, but its solvers do not quote USDC that starts
          on Stellar. Xebra carries it across with Circle&rsquo;s CCTP, straight into the deposit
          address NEAR Intents hands out, and Intents takes it from there.
        </p>
      </header>

      {tracked ? (
        <Tracker
          tracked={tracked}
          onReset={() => {
            remember(null);
            setTracked(null);
          }}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <GlassCard spotlight={false}>
            <div className="flex flex-col gap-6 p-5 sm:p-6">
              <Field
                id="ni-amount"
                label="You send"
                trailing={<span className="text-xs text-bone/40">USDC on Stellar</span>}
              >
                <Input
                  id="ni-amount"
                  inputMode="decimal"
                  className="h-12 text-lg"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>

              <Field id="ni-dest" label="You get" error={destError}>
                {destinations ? (
                  <select
                    id="ni-dest"
                    value={assetId}
                    onChange={(e) => setAssetId(e.target.value)}
                    className="h-12 w-full rounded-tray bg-obsidian-sunken/80 px-4 text-bone ring-1 ring-inset ring-bone/[0.07] hover:ring-bone/[0.16] focus:ring-bone/25"
                  >
                    {destinations.map((d) => (
                      <option key={d.assetId} value={d.assetId}>
                        {d.symbol} on {d.chain}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Skeleton className="h-12 w-full" />
                )}
              </Field>

              <Field
                id="ni-recipient"
                label="Recipient"
                hint={destination ? `Their ${destination.chain} account.` : undefined}
              >
                <Input
                  id="ni-recipient"
                  className="h-12 font-mono text-sm"
                  placeholder={destination?.recipientHint ?? ""}
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>

              {!sender ? (
                <Button size="lg" className="w-full" onClick={() => open(["stellar"])}>
                  Connect a Stellar wallet
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={busy || !via?.available}
                  onClick={send}
                  trailing={<ArrowRight className="h-4 w-4" />}
                >
                  {step === "preparing"
                    ? "Getting a deposit address"
                    : step === "signing"
                      ? "Approve in your wallet"
                      : step === "submitting"
                        ? "Sending"
                        : "Send through Xebra"}
                </Button>
              )}
              {step === "signing" && (
                <div className="flex items-center justify-between gap-4 text-xs leading-relaxed text-bone/45">
                  <span>No window? Open your wallet extension: the request waits there.</span>
                  <button
                    type="button"
                    onClick={cancel}
                    className="shrink-0 text-bone/70 underline-offset-4 hover:text-bone hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {sendError && (
                <Notice tone="alarm" title="The transfer stopped">
                  {sendError}
                </Notice>
              )}
            </div>
          </GlassCard>

          <section aria-label="Two ways to get there" className="flex flex-col gap-4">
            <PathCard
              title="Straight into NEAR Intents"
              detail="Deposit Stellar USDC through the HOT bridge and wait for a solver."
              price={comparison?.direct ?? null}
              loading={pricing}
              symbol={destination?.symbol}
            />
            <PathCard
              title="Through Xebra, then NEAR Intents"
              detail={`Circle burns on Stellar and mints on ${HUB_NAME[via?.hub ?? "base"] ?? via?.hub}, into the deposit address. A solver fills from there.`}
              price={via ?? null}
              loading={pricing}
              symbol={destination?.symbol}
              highlight
            >
              {via?.xebra && (
                <dl className="mt-4 flex flex-col gap-2.5 border-t border-bone/[0.06] pt-4">
                  <DataRow label="Xebra fee" value={`${via.xebra.fees.xebra} USDC`} />
                  <DataRow label="Circle delivery" value={`${via.xebra.fees.delivery} USDC`} />
                  <DataRow
                    label={`Arrives on ${HUB_NAME[via.hub ?? ""] ?? via.hub}`}
                    value={`${via.xebra.recipientGets} USDC`}
                    hint="One for one: no pool, no slippage on this leg."
                  />
                </dl>
              )}
            </PathCard>
            {priceError && (
              <Notice tone="alarm" title="No quote">
                {priceError}
              </Notice>
            )}
          </section>
        </div>
      )}

      <Notice tone="info" title="Real money on mainnet">
        This moves real USDC. Xebra never holds it: you sign one Stellar transaction, Circle mints
        on the other side, and if NEAR Intents cannot fill the swap it refunds to the Intents
        account your Stellar key already owns.
      </Notice>
    </main>
  );
}

function PathCard({
  title,
  detail,
  price,
  loading,
  symbol,
  highlight,
  children,
}: {
  title: string;
  detail: string;
  price: PathPrice | null;
  loading: boolean;
  symbol: string | undefined;
  highlight?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <InsetTray className={cn("px-5 py-5", highlight && "ring-signal/20")}>
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-sm font-medium text-bone/85">{title}</h2>
        {price && (
          <Badge tone={price.available ? "signal" : "neutral"}>
            {price.available ? "Quoted" : "Not available"}
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-bone/40">{detail}</p>
      <div className="mt-4">
        {loading && !price ? (
          <Skeleton className="h-8 w-40" />
        ) : !price ? (
          <p className="text-sm text-bone/35">Enter an amount and a recipient to price it.</p>
        ) : price.available ? (
          <div className="flex items-baseline justify-between gap-4">
            <p className="tabular text-2xl font-semibold tracking-tight text-bone">
              {price.amountOut} <span className="text-base font-medium text-bone/50">{symbol}</span>
            </p>
            <p className="text-xs text-bone/45">
              {price.amountOutUsd ? `$${Number(price.amountOutUsd).toFixed(2)}, ` : ""}
              {minutes(price.timeEstimate)}
            </p>
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-bone/55">{price.reason}</p>
        )}
      </div>
      {children}
    </InsetTray>
  );
}

const XEBRA_DONE = new Set(["delivered"]);
const INTENTS_DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function Tracker({ tracked, onReset }: { tracked: Tracked; onReset: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const q = new URLSearchParams({ depositAddress: tracked.depositAddress, tx: tracked.tx });
        const res = await fetch(`/api/near-intents/status?${q}`);
        if (res.ok && !stop) setStatus((await res.json()) as Status);
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [tracked]);

  const xebraState = status?.xebra?.state ?? "pending";
  const intentsState = status?.intents?.status ?? "PENDING_DEPOSIT";
  // Xebra's own status can lag the chain by a few polls; a mint transaction, or NEAR Intents
  // having seen the deposit at all, already proves the USDC arrived on the hub chain.
  const xebraDone =
    XEBRA_DONE.has(xebraState) ||
    Boolean(status?.xebra?.deliveryTx) ||
    ["PROCESSING", "SUCCESS", "REFUNDED"].includes(status?.intents?.status ?? "");
  const finished = INTENTS_DONE.has(intentsState);
  const out = status?.intents?.swapDetails?.destinationChainTxHashes?.[0];
  const hub = HUB_NAME[tracked.hub] ?? tracked.hub;

  return (
    <GlassCard spotlight={false}>
      <div className="flex flex-col gap-6 p-5 sm:p-7">
        <ol className="flex flex-col gap-5">
          <Leg
            done={xebraDone}
            active={!xebraDone}
            title={`Xebra: Stellar to ${hub}`}
            detail={
              xebraDone
                ? `Circle minted the USDC into the NEAR Intents deposit address on ${hub}.`
                : `Burned on Stellar. Circle attests it and mints on ${hub}, usually within a minute.`
            }
            link={{
              href: `https://stellar.expert/explorer/public/tx/${tracked.tx}`,
              label: "Stellar transaction",
            }}
          />
          <Leg
            done={intentsState === "SUCCESS"}
            active={xebraDone && !finished}
            title={`NEAR Intents: USDC to ${tracked.symbol}`}
            detail={
              intentsState === "SUCCESS"
                ? `Delivered ${status?.intents?.swapDetails?.amountOutFormatted ?? tracked.expectOut} ${tracked.symbol}.`
                : intentsState === "REFUNDED"
                  ? `Refunded ${status?.intents?.swapDetails?.refundedAmountFormatted ?? ""} USDC to your NEAR Intents account.`
                  : intentsState === "FAILED"
                    ? "NEAR Intents reports the swap failed. Funds are refunded to your Intents account."
                    : `Waiting for the deposit, then a solver fills about ${tracked.expectOut} ${tracked.symbol}. (${intentsState.toLowerCase().replaceAll("_", " ")})`
            }
            link={out ? { href: out.explorerUrl, label: "Delivery transaction" } : null}
          />
        </ol>
        <p className="text-xs text-bone/35">
          Deposit address <span className="font-mono text-bone/55">{tracked.depositAddress}</span>
        </p>
        {finished && (
          <Button variant="secondary" onClick={onReset} className="self-start">
            Start another
          </Button>
        )}
      </div>
    </GlassCard>
  );
}

function Leg({
  done,
  active,
  title,
  detail,
  link,
}: {
  done: boolean;
  active: boolean;
  title: string;
  detail: string;
  link: { href: string; label: string } | null;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
          done
            ? "bg-signal/15 text-signal ring-signal/30"
            : active
              ? "ring-bone/40"
              : "ring-bone/15",
        )}
      >
        {done ? (
          <Check className="h-3.5 w-3.5" />
        ) : active ? (
          <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-bone/70" />
        ) : null}
      </span>
      <div className="min-w-0">
        <p className={cn("text-sm font-medium", done || active ? "text-bone/90" : "text-bone/45")}>
          {title}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-bone/50">{detail}</p>
        {link && (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-bone/60 underline-offset-4 hover:text-bone hover:underline"
          >
            {link.label} <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
      </div>
    </li>
  );
}
