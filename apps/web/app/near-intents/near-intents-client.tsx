"use client";

import {
  EVM_CHAINS,
  type EvmChainId,
  evmDestinationsFrom,
  evmSources,
  explorerTxUrl,
} from "@xebra/sdk/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ensureChain, readChainId, sendTransaction, waitForReceipt } from "../../lib/evm-rpc";
import { reportError } from "../../lib/format-error";

/**
 * USDC from a chain NEAR Intents does not reach into anything Intents delivers, with Xebra carrying
 * the USDC.
 *
 * NEAR Intents' solvers do not quote Stellar USDC, and Intents does not list USDC on Arc, Unichain,
 * Sonic, World Chain, Sei, XDC, Ink or Codex at all. Xebra moves the USDC over Circle's CCTP to
 * Base, straight into the deposit address NEAR Intents issues, and Intents does the rest. The page
 * prices both paths side by side from live quotes, then asks the user's own wallet to sign on their
 * own chain: one Stellar transaction, or an approval and a burn on an EVM chain.
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

/** The wallet-side half of the API's `UnsignedTx`: only the fields this page reads. */
interface UnsignedTx {
  kind: string;
  xdr?: string;
  networkPassphrase?: string;
  chainId?: number;
  to?: string;
  data?: string;
}

interface Comparison {
  direct: PathPrice;
  viaXebra: PathPrice & { hub?: string; xebra?: XebraQuote };
}

interface Tracked {
  /** The source chain; absent on swaps saved before other chains existed, which were Stellar. */
  from?: Source;
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
const HUBS = ["base", "arbitrum"] as const;

type Source = "stellar" | EvmChainId;

/** Stands in for the sender while pricing, before a wallet is connected. */
const PLACEHOLDER_SENDER = {
  stellar: "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L",
  evm: "0x1111111111111111111111111111111111111111",
};

/**
 * Stellar, then each EVM chain this build lets send to a NEAR Intents hub, in the table's order.
 * A chain with no route to a hub has nothing to offer here.
 */
function swapSources(): Source[] {
  const evm = evmSources(env.evmRoutes).filter((id) =>
    evmDestinationsFrom(id, env.evmRoutes).some((d) => (HUBS as readonly string[]).includes(d)),
  );
  // Arc first after Stellar: NEAR Intents does not list it at all, so it is the route people come for.
  const arcFirst = evm.includes("arc")
    ? ["arc" as const, ...evm.filter((id) => id !== "arc")]
    : evm;
  return ["stellar", ...arcFirst];
}

const chainName = (s: Source) => (s === "stellar" ? "Stellar" : EVM_CHAINS[s].name);

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
  const { connections, stellarKit: kit, open, syncEvmChain } = useWallets();
  const sources = useMemo(swapSources, []);
  const [from, setFrom] = useState<Source>("stellar");
  const isStellar = from === "stellar";
  const sender = (isStellar ? connections.stellar?.address : connections.evm?.address) ?? null;

  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [destError, setDestError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState("");
  const [amount, setAmount] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "burning" | "submitting">(
    "idle",
  );
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
        from,
        amount: amount.trim(),
        sender: sender ?? PLACEHOLDER_SENDER[from === "stellar" ? "stellar" : "evm"],
        destinationAsset: destination.assetId,
        recipient: recipient.trim(),
      })
        .then((c) => id === ticket.current && setComparison(c))
        .catch((e) => id === ticket.current && setPriceError(reportError("The quote", e)))
        .finally(() => id === ticket.current && setPricing(false));
    }, 600);
    return () => clearTimeout(t);
  }, [from, amount, recipient, destination, sender]);

  // Each press gets a number. Cancelling bumps it, so a wallet or network answer that arrives
  // after the person gave up is ignored instead of yanking the page into a transfer they left.
  const attempt = useRef(0);

  const cancel = useCallback(() => {
    attempt.current += 1;
    setStep("idle");
    setSendError(
      isStellar
        ? "Cancelled. Nothing was sent: no transaction reached Stellar."
        : `Cancelled. Nothing was burned on ${chainName(from)}. If you had already approved, the approval stays and covers exactly this amount; the next attempt reuses it.`,
    );
  }, [isStellar, from]);

  const send = useCallback(async () => {
    if (!sender || !destination) return;
    if (isStellar && !kit) return;
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
          build: { steps: { id: string; tx: UnsignedTx }[] };
        }>("/api/near-intents/prepare", {
          from,
          amount: amount.trim(),
          sender,
          destinationAsset: destination.assetId,
          recipient: recipient.trim(),
        }),
        60_000,
        "NEAR Intents took too long to issue a deposit address. Nothing was sent; try again.",
      );
      if (!live()) return;
      console.info("[xebra] near-intents: deposit address", prepared.depositAddress);

      const txHash = isStellar
        ? await signOnStellar(prepared.build.steps, live)
        : await signOnEvm(prepared.build.steps, live);
      if (!txHash || !live()) return;
      console.info("[xebra] near-intents: submitted", txHash);
      const t: Tracked = {
        from,
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

    /** One Stellar transaction: signed in the wallet, submitted by our server. */
    async function signOnStellar(steps: { tx: UnsignedTx }[], live: () => boolean) {
      const tx = steps[0]?.tx;
      if (steps.length !== 1 || tx?.kind !== "stellar" || !tx.xdr || !kit || !sender) {
        throw new Error("Expected a single Stellar transaction to sign.");
      }
      setStep("signing");
      const passphrase = tx.networkPassphrase ?? env.stellarNetworkPassphrase;
      const { signedTxXdr } = await kit.signTransaction(tx.xdr, {
        networkPassphrase: passphrase,
        address: sender,
      });
      if (!live()) return null;
      console.info("[xebra] near-intents: signed, submitting to Stellar");
      setStep("submitting");
      // Submitted by our server, which retries a failed connection; the browser's own link to
      // Stellar's RPC is the part that dropped signed transfers with "Network Error".
      const { txHash } = await withTimeout(
        post<{ txHash: string }>("/api/near-intents/submit", { xdr: signedTxXdr }),
        90_000,
        "Stellar's network did not answer in time. Check your wallet's activity before trying again: if the transaction shows there, it went through.",
      );
      return txHash;
    }

    /**
     * An exact-amount approval (when the allowance is short) and the burn, on the source chain, in
     * order, each confirmed before the next. Returns the burn's hash.
     */
    async function signOnEvm(steps: { id: string; tx: UnsignedTx }[], live: () => boolean) {
      const provider = connections.evm?.provider;
      if (from === "stellar" || !provider || !sender) throw new Error("Connect an EVM wallet.");
      const chain = EVM_CHAINS[from];
      const ok =
        steps.length > 0 &&
        steps.at(-1)?.id === "burn" &&
        steps.every(
          (s) => s.tx.kind === "evm" && s.tx.chainId === chain.chainId && s.tx.to && s.tx.data,
        );
      if (!ok) throw new Error(`Expected an approval and a burn on ${chain.name}.`);
      setStep("signing");
      await ensureChain(provider, chain);
      await syncEvmChain();
      if ((await readChainId(provider)) !== chain.chainId) {
        throw new Error(`Switch your wallet to ${chain.name} and try again.`);
      }
      let burn: string | null = null;
      for (const s of steps) {
        if (!live()) return null;
        setStep(s.id === "approve" ? "signing" : "burning");
        const hash = await sendTransaction(provider, {
          from: sender,
          to: s.tx.to as string,
          data: s.tx.data as `0x${string}`,
          chainId: chain.chainId,
        });
        setStep("submitting");
        const result = await waitForReceipt(provider, hash, { timeoutMs: 180_000 });
        if (result !== "success") {
          throw new Error(
            `${s.id === "approve" ? "The approval" : "The burn"} reverted on ${chain.name}: ${explorerTxUrl(chain, hash)}`,
          );
        }
        if (s.id === "burn") burn = hash;
      }
      return burn;
    }
  }, [kit, sender, destination, amount, recipient, from, isStellar, connections.evm, syncEvmChain]);

  const busy = step !== "idle";
  const via = comparison?.viaXebra;
  const direct = comparison?.direct;
  // Xebra adds nothing when NEAR Intents already takes this chain's USDC and pays more for it.
  const directWins =
    direct?.available &&
    via?.available &&
    Number(direct.amountOut ?? 0) >= Number(via.amountOut ?? 0);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-14 sm:px-5 sm:py-20">
      <header className="max-w-2xl px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance] sm:text-3xl">
          USDC into NEAR Intents, from chains it does not reach
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-bone/55">
          NEAR Intents can swap into almost anything, but its solvers do not quote USDC that starts
          on Stellar, and it does not list USDC on Arc, Unichain, Sonic, World Chain and other
          Circle chains at all. Xebra carries it across with Circle&rsquo;s CCTP, straight into the
          deposit address NEAR Intents hands out, and Intents takes it from there.
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
              {sources.length > 1 && (
                <Field id="ni-from" label="From">
                  <select
                    id="ni-from"
                    value={from}
                    disabled={busy}
                    onChange={(e) => setFrom(e.target.value as Source)}
                    className="h-12 w-full rounded-tray bg-obsidian-sunken/80 px-4 text-bone ring-1 ring-inset ring-bone/[0.07] transition-shadow duration-200 hover:ring-bone/[0.16] focus:ring-bone/25 disabled:opacity-60"
                  >
                    {sources.map((s) => (
                      <option key={s} value={s}>
                        {chainName(s)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <Field
                id="ni-amount"
                label="You send"
                trailing={<span className="text-xs text-bone/40">USDC on {chainName(from)}</span>}
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
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => open([isStellar ? "stellar" : "evm"])}
                >
                  {isStellar ? "Connect a Stellar wallet" : "Connect an EVM wallet"}
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={busy || !via?.available || Boolean(directWins)}
                  onClick={send}
                  trailing={<ArrowRight className="h-4 w-4" />}
                >
                  {step === "preparing"
                    ? "Getting a deposit address"
                    : step === "signing"
                      ? "Approve in your wallet"
                      : step === "burning"
                        ? "Confirm the transfer in your wallet"
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
              detail={
                isStellar
                  ? "Deposit Stellar USDC through the HOT bridge and wait for a solver."
                  : `Deposit ${chainName(from)} USDC into NEAR Intents and wait for a solver.`
              }
              price={comparison?.direct ?? null}
              loading={pricing}
              symbol={destination?.symbol}
            />
            <PathCard
              title="Through Xebra, then NEAR Intents"
              detail={`Circle burns on ${chainName(from)} and mints on ${HUB_NAME[via?.hub ?? "base"] ?? via?.hub}, into the deposit address. A solver fills from there.`}
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
            {directWins && (
              <Notice tone="info" title="Go direct for this one">
                NEAR Intents already takes {chainName(from)} USDC and pays more for this swap than
                the route through Xebra. Use NEAR Intents&rsquo; own app: Xebra adds nothing here.
              </Notice>
            )}
            {priceError && (
              <Notice tone="alarm" title="No quote">
                {priceError}
              </Notice>
            )}
          </section>
        </div>
      )}

      <Notice tone="info" title="Real money on mainnet">
        This moves real USDC. Xebra never holds it: you sign on {chainName(from)}, Circle mints on
        the other side, and if NEAR Intents cannot fill the swap it refunds{" "}
        {isStellar
          ? "to the Intents account your Stellar key already owns."
          : `the USDC to your same address on ${HUB_NAME[via?.hub ?? "base"] ?? "the hub chain"}.`}
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

/** Where a mint on each hub chain can be inspected. */
const HUB_TX: Record<string, string> = {
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  solana: "https://solscan.io/tx/",
};

/**
 * NEAR Intents sometimes reports a delivery with an empty explorer link. Its swaps settle on NEAR,
 * so a hash without an explorer link that is not an EVM hash is a NEAR transaction.
 */
function deliveryUrl(out: { hash: string; explorerUrl: string }): string {
  if (out.explorerUrl) return out.explorerUrl;
  return out.hash.startsWith("0x")
    ? `https://blockscan.com/tx/${out.hash}`
    : `https://nearblocks.io/txns/${out.hash}`;
}

const XEBRA_DONE = new Set(["delivered"]);
const INTENTS_DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function Tracker({ tracked, onReset }: { tracked: Tracked; onReset: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const q = new URLSearchParams({
          depositAddress: tracked.depositAddress,
          tx: tracked.tx,
          from: tracked.from ?? "stellar",
        });
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
  const source = tracked.from ?? "stellar";
  const sourceName = chainName(source);
  const burnUrl =
    source === "stellar"
      ? `https://stellar.expert/explorer/public/tx/${tracked.tx}`
      : explorerTxUrl(EVM_CHAINS[source], tracked.tx);
  const eta = source === "stellar" ? "within a minute" : EVM_CHAINS[source].standardEta;
  const refundTo =
    source === "stellar" ? "your NEAR Intents account" : `your own address on ${hub}`;

  return (
    <GlassCard spotlight={false}>
      <div className="flex flex-col gap-6 p-5 sm:p-7">
        <ol className="flex flex-col gap-5">
          <Leg
            done={xebraDone}
            active={!xebraDone}
            title={`Xebra: ${sourceName} to ${hub}`}
            detail={
              xebraDone
                ? `Circle minted the USDC into the NEAR Intents deposit address on ${hub}.`
                : `Burned on ${sourceName}. Circle attests it and mints on ${hub}, usually ${eta}.`
            }
            links={[
              { href: burnUrl, label: `Burn on ${sourceName}` },
              ...(status?.xebra?.deliveryTx && HUB_TX[tracked.hub]
                ? [
                    {
                      href: `${HUB_TX[tracked.hub]}${status.xebra.deliveryTx}`,
                      label: `Mint on ${hub}`,
                    },
                  ]
                : []),
            ]}
          />
          <Leg
            done={intentsState === "SUCCESS"}
            active={xebraDone && !finished}
            title={`NEAR Intents: swap and deliver ${tracked.symbol}`}
            detail={
              intentsState === "SUCCESS"
                ? `Delivered ${status?.intents?.swapDetails?.amountOutFormatted ?? tracked.expectOut} ${tracked.symbol}.`
                : intentsState === "REFUNDED"
                  ? `Refunded ${status?.intents?.swapDetails?.refundedAmountFormatted ?? ""} USDC to ${refundTo}.`
                  : intentsState === "FAILED"
                    ? `NEAR Intents reports the swap failed. Funds are refunded to ${refundTo}.`
                    : `Waiting for the deposit, then a solver fills about ${tracked.expectOut} ${tracked.symbol}. (${intentsState.toLowerCase().replaceAll("_", " ")})`
            }
            links={out ? [{ href: deliveryUrl(out), label: "Delivery transaction" }] : []}
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
  links,
}: {
  done: boolean;
  active: boolean;
  title: string;
  detail: string;
  links: { href: string; label: string }[];
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
        {links.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-bone/60 underline-offset-4 hover:text-bone hover:underline"
              >
                {l.label} <ArrowUpRight className="h-3 w-3" />
              </a>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}
