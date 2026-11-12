"use client";

import {
  type DeepLink,
  EVM_CHAINS,
  type EvmChainId,
  evmSources,
  hasDeepLink,
  isEvmChainId,
  parseDeepLink,
} from "@xebra/sdk/core";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SuiTransfer, hasRememberedSuiTransfer } from "../../app/sui/sui-client";
import { env, isCctpRailConfigured } from "../../lib/env";
import { SiteFooter } from "../site/site-footer";
import { TopBar } from "../site/top-bar";
import { Eyebrow } from "../ui/badge";
import { GlassCard } from "../ui/glass-card";
import { Fingerprint, Spark, Vault } from "../ui/icons";
import { Notice } from "../ui/notice";
import { Reveal } from "../ui/reveal";
import { useWallets } from "../wallet/wallet-provider";
import { CHAIN_NAMES, type Chain } from "./chain-glyph";
import { ChainPicker, PickerLabel } from "./chain-picker";
import { EvmBridgeForm } from "./evm-bridge-form";
import { StellarBridgeForm } from "./stellar-bridge-form";

/**
 * The bridge screen: the hero, the one plate that moves money, and what stands behind it.
 *
 * The plate's contents are a form per kind of source chain (`components/bridge/*-bridge-form`).
 * This file is the frame around them, which is the part that does not change with the route.
 * `app/page.tsx` renders it and passes the server-rendered sections below the plate as children.
 *
 * A link can preselect and prefill the route (`/?from=stellar&to=base&amount=25`, as the route pages use). It is read
 * from `window.location` after mounting rather than through `useSearchParams`, which would turn the
 * whole page into client-only rendering and leave crawlers an empty shell.
 */
/** Where a transfer can start: Stellar, through the wrapper, or an EVM chain, straight to Circle. */
type SourceId = "stellar" | "sui" | EvmChainId;

/** What `/api/sui-stellar/config` says about the Sui source: absent until it answers, and when it is off. */
interface SuiSource {
  relayer: boolean;
  maxUsdc: string | null;
  /** EVM chains Sui also sends to. */
  evm: EvmChainId[];
}

export function HomeClient({ children }: { children?: React.ReactNode }) {
  const { connections, stellarKit: kit, open: openWallets } = useWallets();
  const connect = useCallback(() => openWallets(["stellar", "solana", "evm"]), [openWallets]);

  // Stellar always; an EVM chain only once this build lets it send. With none on, there is one
  // source, no picker, and the screen is exactly the Stellar one.
  // Sui is switched on by a server setting, so it is asked for after mounting. Until it answers, or
  // when it is off, the screen is exactly what it was.
  const [sui, setSui] = useState<SuiSource | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/sui-stellar/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          c: {
            enabled?: boolean;
            relayer?: boolean;
            maxUsdc?: string | null;
            evm?: unknown;
          } | null,
        ) => {
          if (!live || !c?.enabled) return;
          setSui({
            relayer: c.relayer === true,
            maxUsdc: c.maxUsdc ?? null,
            // Only names this build knows: a newer server cannot make the page render a chain it lacks.
            evm: Array.isArray(c.evm)
              ? c.evm.filter((id): id is EvmChainId => typeof id === "string" && isEvmChainId(id))
              : [],
          });
          // A transfer this browser was following comes back on screen, as it does on /sui.
          if (hasRememberedSuiTransfer() && !parseDeepLink(window.location.search).from) {
            setFrom("sui");
          }
        },
      )
      .catch(() => {
        // Off, or offline: the Sui source simply is not offered.
      });
    return () => {
      live = false;
    };
  }, []);

  const sources = useMemo<SourceId[]>(
    () => ["stellar", ...(sui ? (["sui"] as const) : []), ...evmSources(env.evmRoutes)],
    [sui],
  );
  const manyRoutes = sources.length > 1;
  const [from, setFrom] = useState<SourceId>("stellar");
  // A transfer being signed, or a receipt on show, belongs to the source it started from.
  // Changing the source then would throw away the only place its hash is displayed.
  const [busy, setBusy] = useState(false);
  // What a link asked to have filled in (`packages/sdk/src/core/deep-link.ts`). Read once after mount, because the
  // server render cannot know the query. Prefill only: the person still reviews and signs.
  const [link, setLink] = useState<DeepLink | null>(null);
  useEffect(() => {
    const parsed = parseDeepLink(window.location.search);
    if (!hasDeepLink(parsed)) return;
    setLink(parsed);
    if (parsed.from && sources.includes(parsed.from)) setFrom(parsed.from);
  }, [sources]);
  // A link speaks for the source it named (Stellar when it named none).
  const prefill = link && (link.from ?? "stellar") === from ? link : null;

  const sourcePicker = manyRoutes ? (
    <div className="mb-6">
      <PickerLabel>Send from</PickerLabel>
      <ChainPicker<Chain>
        legend="Source chain"
        name="source-chain"
        options={sources.map((id) => ({ id, name: CHAIN_NAMES[id] }))}
        value={from}
        onChange={(id) => {
          setFrom(id as SourceId);
          setLink(null);
        }}
        disabled={busy}
      />
    </div>
  ) : null;

  return (
    <>
      <TopBar
        connections={connections}
        walletReady={Boolean(kit)}
        network={env.network}
        onConnect={connect}
      />

      <main className="mx-auto w-full max-w-xl px-4 pt-16 sm:px-5 sm:pt-24">
        <Reveal as="header" className="px-1">
          <Eyebrow>
            {manyRoutes ? "Native USDC · Circle CCTP" : "Native USDC · from Stellar"}
          </Eyebrow>
          <h1 className="mt-6 text-display font-semibold text-bone [text-wrap:balance]">
            {manyRoutes ? "Burned here." : "Two chains."}
            <br />
            <span className="text-bone/45">{manyRoutes ? "Minted there." : "One signature."}</span>
          </h1>
          <p className="mt-6 max-w-[36ch] text-[0.9375rem] leading-relaxed text-bone/45">
            {manyRoutes ? (
              "Circle burns your USDC on the chain you send from and mints the same dollars on the one you send to."
            ) : (
              <>
                Circle burns your USDC on Stellar and mints the same dollars on{" "}
                {env.stellarSendsTo.length > 0
                  ? "the chain you choose"
                  : env.arcEnabled
                    ? "Solana or Arc"
                    : "Solana"}
                .
              </>
            )}{" "}
            No wrapped asset, no bridge token, and nobody holds your funds in between.
          </p>
        </Reveal>

        {from === "stellar" && !isCctpRailConfigured && (
          <Reveal delay={80} className="mt-10">
            <Notice tone="alarm" title="Bridging is not available yet">
              The bridge contract is not configured for this deployment, so no transfer can be
              started. Nothing has been sent.
            </Notice>
          </Reveal>
        )}

        <Reveal delay={140} className="mt-12">
          <GlassCard id="bridge" labelledBy="bridge-heading" className="scroll-mt-24">
            {prefill && (
              <Notice tone="info" title="Filled in from a link" className="mb-6">
                Check the amount and the recipient address before you sign. Nothing is sent until
                you approve it in your wallet.
              </Notice>
            )}
            {from === "stellar" ? (
              <StellarBridgeForm
                sourcePicker={sourcePicker}
                onBusyChange={setBusy}
                prefill={prefill}
              />
            ) : from === "sui" && sui ? (
              <SuiTransfer
                embedded
                maxUsdc={sui.maxUsdc}
                relayerEnabled={sui.relayer}
                evmDestinations={sui.evm}
                sourcePicker={sourcePicker}
                onBusyChange={setBusy}
              />
            ) : from === "sui" ? null : (
              // Keyed by source: a different chain is a different transfer, and nothing typed for
              // one (least of all a receipt) should survive into another.
              <EvmBridgeForm
                key={from}
                source={EVM_CHAINS[from]}
                routes={env.evmRoutes}
                sourcePicker={sourcePicker}
                onBusyChange={setBusy}
                prefill={prefill}
              />
            )}
          </GlassCard>
        </Reveal>

        <Reveal delay={220}>
          <Assurances />
        </Reveal>

        {children}
      </main>

      <SiteFooter
        wrapperContractId={env.cctpWrapperContractId}
        {...(manyRoutes ? { contractLabel: "Stellar contract" } : {})}
      />
    </>
  );
}

/**
 * Three claims, on one hairline-separated row rather than three cards. They are supporting
 * detail; giving each its own elevated surface would put them in competition with the plate
 * that actually does the work.
 */
function Assurances() {
  const items = [
    { icon: Vault, title: "Non-custodial", body: "Funds move contract to contract." },
    { icon: Fingerprint, title: "Circle-attested", body: "Each burn carries its own proof." },
    { icon: Spark, title: "Delivered for you", body: "Circle mints it. Usually a few minutes." },
  ];

  return (
    <ul className="mt-12 grid gap-px overflow-hidden rounded-tray bg-bone/[0.06] sm:grid-cols-3">
      {items.map(({ icon: Icon, title, body }) => (
        <li key={title} className="bg-obsidian/90 px-4 py-5">
          <Icon className="h-[1.125rem] w-[1.125rem] text-bone/40" />
          <h3 className="mt-3 text-[0.8125rem] font-medium tracking-[-0.01em] text-bone/80">
            {title}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-bone/35">{body}</p>
        </li>
      ))}
    </ul>
  );
}
