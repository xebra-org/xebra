"use client";

import { hasEvmRoutes } from "@xebra/sdk/core";
import { useEffect, useRef, useState } from "react";
import { env } from "../../lib/env";
import {
  type Connection,
  FAMILY_LABEL,
  type Family,
  type WalletEntry,
} from "../../lib/wallets/types";
import { cn } from "../ui/cn";

/**
 * What each kind of wallet is for. An EVM wallet was only ever a recipient and a way to claim until
 * the routes between Arc and other EVM chains existed; with those switched on it also pays, and a
 * Stellar wallet is no longer the only way to send.
 */
const EVM_SENDS = hasEvmRoutes(env.evmRoutes);

const BLURB: Record<Family, string> = {
  stellar: EVM_SENDS
    ? "Pays for and signs a transfer that starts on Stellar."
    : "Pays for the transfer and signs it. Required to send.",
  solana: "Fills in your Solana address as the recipient.",
  evm: EVM_SENDS
    ? "Pays for and signs a transfer that starts on an EVM chain, fills in a recipient, and completes a claim."
    : "Fills in your Arc address as the recipient, and completes a claim.",
  sui: "Pays for and signs a transfer that starts on Sui.",
};

/**
 * The one wallet picker, for every chain.
 *
 * A native <dialog> opened with showModal(): the browser supplies the focus trap, Escape to close,
 * inert background and return of focus, none of which a hand-built overlay gets right by default.
 * Tabs are only the families the caller asked for, so the admin panel can ask for "Stellar" alone
 * and the recipient field for "Solana" or "EVM" without showing what is irrelevant.
 */
export function WalletModal({
  families,
  entries,
  connections,
  pending,
  error,
  onConnect,
  onDisconnect,
  onClose,
}: {
  families: readonly Family[] | null;
  entries: Record<Family, WalletEntry[]>;
  connections: Partial<Record<Family, Connection>>;
  pending: string | null;
  error: string | null;
  onConnect: (e: WalletEntry) => void;
  onDisconnect: (f: Family) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Family>("stellar");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (families && !d.open) {
      setTab(families[0] ?? "stellar");
      d.showModal();
    }
    if (!families && d.open) d.close();
  }, [families]);

  const shown = families ?? [];
  const list = entries[tab];
  const conn = connections[tab];

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Escape closes a modal <dialog> natively
    <dialog
      ref={ref}
      aria-label="Connect a wallet"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl outline-none bg-obsidian-raised p-0 text-bone",
        "ring-1 ring-inset ring-bone/12 backdrop:bg-obsidian/70 backdrop:backdrop-blur-sm",
        "shadow-[0_40px_80px_-32px_hsl(228_40%_2%/0.95)]",
      )}
    >
      <div className="flex items-center justify-between px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold tracking-tight">Connect a wallet</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-full text-bone/50 transition-colors hover:bg-bone/10 hover:text-bone"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {shown.length > 1 ? (
        <div
          role="tablist"
          aria-label="Chain"
          className="mx-5 flex gap-1 rounded-full bg-obsidian p-1"
        >
          {shown.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={tab === f}
              onClick={() => setTab(f)}
              className={cn(
                "flex-1 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium transition-colors",
                tab === f ? "bg-bone text-obsidian" : "text-bone/55 hover:text-bone",
              )}
            >
              {FAMILY_LABEL[f]}
              {connections[f] ? (
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-signal align-middle"
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="px-5 pb-5 pt-4">
        <p className="text-[0.8125rem] leading-relaxed text-bone/45">{BLURB[tab]}</p>

        {conn ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-bone/[0.05] p-3 ring-1 ring-inset ring-bone/10">
            <div className="min-w-0">
              <p className="text-[0.75rem] text-bone/45">Connected · {conn.walletName}</p>
              <p className="tabular truncate font-mono text-sm" title={conn.address}>
                {conn.address.slice(0, 6)}…{conn.address.slice(-6)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDisconnect(tab)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[0.8125rem] text-bone/60 ring-1 ring-inset ring-bone/15 transition-colors hover:text-bone hover:ring-bone/30"
            >
              Disconnect
            </button>
          </div>
        ) : null}

        <ul className="mt-4 space-y-2">
          {list.length === 0 ? (
            <li className="rounded-2xl p-4 text-[0.8125rem] leading-relaxed text-bone/50 ring-1 ring-inset ring-bone/10">
              No {FAMILY_LABEL[tab]} wallet detected in this browser. Install one and reload this
              page.
            </li>
          ) : (
            list.map((w) => (
              <li key={w.key}>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => onConnect(w)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-1 ring-inset transition-colors",
                    "ring-bone/10 hover:bg-bone/[0.06] hover:ring-bone/25",
                    "disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent",
                  )}
                >
                  {w.icon ? (
                    <img
                      src={w.icon}
                      alt=""
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-lg"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="grid h-8 w-8 place-items-center rounded-lg bg-bone/10 text-xs"
                    >
                      {w.name.slice(0, 1)}
                    </span>
                  )}
                  <span className="flex-1 text-[0.9375rem] font-medium">{w.name}</span>
                  <span className="text-[0.75rem] text-bone/45">
                    {pending === w.key
                      ? "Check your wallet…"
                      : w.installed
                        ? connections[w.family]?.walletKey === w.key
                          ? "Connected"
                          : "Detected"
                        : "Not detected · try anyway"}
                  </span>
                </button>
                {!w.installed && w.installUrl ? (
                  <a
                    href={w.installUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 block px-3 text-[0.75rem] text-bone/45 underline underline-offset-2 hover:text-bone"
                  >
                    Get {w.name}
                  </a>
                ) : null}
              </li>
            ))
          )}
        </ul>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-2xl bg-alarm/10 p-3 text-[0.8125rem] leading-relaxed text-alarm ring-1 ring-inset ring-alarm/25"
          >
            {error}
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
