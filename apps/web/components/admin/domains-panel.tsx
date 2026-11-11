"use client";

import { EVM_CHAINS } from "@xebra/sdk/core";
import { useEffect, useMemo, useState } from "react";
import {
  type DomainCfg,
  canDo,
  classifyDomainChange,
  validateDomainCfg,
} from "../../lib/admin/policy";
import { fieldToStroops, stroopsToField } from "../../lib/admin/units";
import type { PanelProps } from "./context";
import { Btn, KindTag, NumField, Panel, Toggle } from "./primitives";

/**
 * Circle's ids, named. Every chain in the table comes from the table itself, so a chain added there
 * is named here too; the rest are Circle domains that are not in it. Names only; the contract knows
 * domains by number.
 */
const KNOWN: Record<number, string> = {
  0: "Ethereum",
  5: "Solana",
  11: "Linea",
  17: "BNB Smart Chain",
  22: "Plume",
  25: "Starknet",
  27: "Stellar",
  28: "EDGE",
  ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [c.cctpDomainId, c.name])),
};
export const domainName = (d: number) => KNOWN[d] ?? `Domain ${d}`;

const u = (s: bigint) => `${stroopsToField(s)} USDC`;

/** An EVM chain from Stellar: forwarding on, capped at 0.25 USDC, about twice today's dearest quote. */
const NEW_DOMAIN: DomainCfg = {
  domain: 0,
  evmStyle: true,
  forward: true,
  maxForwardFee: 2_500_000n,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
};

export function DomainsPanel(props: PanelProps) {
  const { state } = props;
  const [editing, setEditing] = useState<number | "new" | null>(null);
  return (
    <Panel
      code="03"
      title="Destinations"
      aside={
        <Btn
          disabled={props.role !== "admin"}
          onClick={() => setEditing(editing === "new" ? null : "new")}
        >
          {editing === "new" ? "Close" : "+ Add chain"}
        </Btn>
      }
    >
      <div className="grid gap-px border border-bone/20 bg-bone/20">
        <div className="hidden grid-cols-[1.4fr_0.6fr_0.8fr_1fr_1fr_auto] gap-3 bg-obsidian px-3 py-2 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45 md:grid">
          <span>Chain</span>
          <span>Forward</span>
          <span>Style</span>
          <span>Fee cap</span>
          <span>New-account cap</span>
          <span />
        </div>
        {state.domains.map((d) => (
          <div key={d.domain} className="bg-obsidian">
            <div className="grid grid-cols-2 items-center gap-3 px-3 py-3 font-mono text-sm uppercase md:grid-cols-[1.4fr_0.6fr_0.8fr_1fr_1fr_auto]">
              <span>
                {domainName(d.domain)} <span className="text-bone/40">#{d.domain}</span>
              </span>
              <span className={d.forward ? "text-signal" : "text-[#ff3b30]"}>
                {d.forward ? "ON" : "OFF"}
              </span>
              <span className="text-bone/70">{d.evmStyle ? "EVM" : "SOLANA-STYLE"}</span>
              <span className="tabular">{u(d.maxForwardFee)}</span>
              <span className="tabular text-bone/70">
                {d.accountCreation ? u(d.maxForwardFeeNewAccount) : "—"}
              </span>
              <Btn onClick={() => setEditing(editing === d.domain ? null : d.domain)}>
                {editing === d.domain ? "Close" : "Edit"}
              </Btn>
            </div>
            {editing === d.domain ? (
              <DomainEditor {...props} initial={d} current={d} onDone={() => setEditing(null)} />
            ) : null}
          </div>
        ))}
        {editing === "new" ? (
          <div className="bg-obsidian">
            <DomainEditor
              {...props}
              initial={NEW_DOMAIN}
              current={null}
              onDone={() => setEditing(null)}
            />
          </div>
        ) : null}
      </div>
      <p className="mt-3 font-mono text-[0.625rem] uppercase leading-relaxed tracking-[0.06em] text-bone/40">
        A chain can be added only if Circle lists it as a forwarding destination. Adding one,
        turning forwarding on, or raising a cap waits 48h. Turning forwarding off or lowering a cap
        is instant.
      </p>
    </Panel>
  );
}

function DomainEditor({
  initial,
  current,
  role,
  busy,
  request,
  state,
  onDone,
}: PanelProps & { initial: DomainCfg; current: DomainCfg | null; onDone: () => void }) {
  const [id, setId] = useState(String(initial.domain));
  const [evm, setEvm] = useState(initial.evmStyle);
  const [forward, setForward] = useState(initial.forward);
  const [cap, setCap] = useState(stroopsToField(initial.maxForwardFee));
  const [creation, setCreation] = useState(initial.accountCreation);
  const [newCap, setNewCap] = useState(stroopsToField(initial.maxForwardFeeNewAccount));
  useEffect(() => {
    setEvm(initial.evmStyle);
    setForward(initial.forward);
    setCap(stroopsToField(initial.maxForwardFee));
    setCreation(initial.accountCreation);
    setNewCap(stroopsToField(initial.maxForwardFeeNewAccount));
  }, [initial]);

  const isNew = current === null;
  const domain = Number(id);
  const existing = isNew ? (state.domains.find((d) => d.domain === domain) ?? null) : current;

  const candidate = useMemo(() => {
    const c = fieldToStroops(cap);
    const n = fieldToStroops(newCap);
    if (c === null || n === null || !Number.isInteger(domain)) return null;
    // Same normalisation the contract applies: creation needs forwarding, and an off switch has no cap.
    const creationOn = creation && forward;
    return {
      domain,
      evmStyle: evm,
      forward,
      maxForwardFee: c,
      accountCreation: creationOn,
      maxForwardFeeNewAccount: creationOn ? n : 0n,
    } satisfies DomainCfg;
  }, [cap, newCap, domain, evm, forward, creation]);

  const checked = candidate ? validateDomainCfg(candidate) : null;
  const kind = !checked || !checked.ok ? "invalid" : classifyDomainChange(existing, checked.value);
  const action = kind === "tighten" ? "tighten_domain" : "propose_domain";
  const allowed = kind !== "invalid" && kind !== "noop" && canDo(role, action);
  const pendingBlocks = kind === "propose" && state.pendingDomain !== null;

  function submit() {
    if (!checked || !checked.ok || kind === "noop" || kind === "invalid") return;
    const cfg = checked.value;
    const lines = [
      `${domainName(cfg.domain)} (#${cfg.domain}) — ${cfg.evmStyle ? "EVM" : "Solana-style"} addresses`,
      `Forwarding ${existing ? (existing.forward ? "ON" : "OFF") : "new"} -> ${cfg.forward ? "ON" : "OFF"}`,
      `Fee cap ${existing ? u(existing.maxForwardFee) : "new"} -> ${u(cfg.maxForwardFee)}`,
      `Account creation ${cfg.accountCreation ? `ON, cap ${u(cfg.maxForwardFeeNewAccount)}` : "OFF"}`,
    ];
    request({
      call:
        kind === "tighten"
          ? { action: "tighten_domain", caller: "", cfg }
          : { action: "propose_domain", cfg },
      title: kind === "tighten" ? "Apply now (tightening)" : "Propose (live after 48h)",
      detail: lines,
      danger: !cfg.forward,
    });
    onDone();
  }

  return (
    <div className="border-t border-bone/20 p-3">
      <div className="grid grid-cols-1 gap-px border border-bone/20 bg-bone/20 sm:grid-cols-2 lg:grid-cols-3">
        {isNew ? (
          <NumField
            label="CCTP domain id"
            unit="#"
            value={id}
            onChange={setId}
            hint={domainName(domain)}
          />
        ) : null}
        <Toggle
          label="Forwarding"
          on={forward}
          onChange={setForward}
          disabled={role === "viewer"}
        />
        <NumField
          label="Forward fee cap"
          unit="USDC"
          value={cap}
          onChange={setCap}
          current={existing ? stroopsToField(existing.maxForwardFee) : undefined}
          hint="Most a signed max_fee may be. 0-2."
          disabled={role === "viewer"}
        />
        {isNew ? (
          <Toggle
            label="EVM-style addresses"
            on={evm}
            onChange={setEvm}
            hint="Off = 32-byte (Solana)."
          />
        ) : null}
        <Toggle
          label="Account creation"
          on={creation && forward}
          onChange={setCreation}
          disabled={role === "viewer" || evm || !forward}
          hint="Solana-style only."
        />
        <NumField
          label="New-account cap"
          unit="USDC"
          value={creation && forward ? newCap : "0"}
          onChange={setNewCap}
          current={existing ? stroopsToField(existing.maxForwardFeeNewAccount) : undefined}
          disabled={role === "viewer" || !(creation && forward)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <KindTag kind={kind} />
        <Btn
          tone={forward ? "solid" : "danger"}
          disabled={busy || !allowed || pendingBlocks}
          onClick={submit}
        >
          {kind === "tighten" ? "Apply now" : "Propose"}
        </Btn>
        {!isNew && existing && canDo(role, "remove_domain") ? (
          <Btn
            tone="danger"
            disabled={busy}
            onClick={() => {
              request({
                call: { action: "remove_domain", caller: "", domain: existing.domain },
                title: "Remove destination (instant)",
                detail: [
                  `${domainName(existing.domain)} (#${existing.domain}) will be refused by the contract immediately.`,
                  "Re-adding it later takes the 48h timelock.",
                ],
                danger: true,
              });
              onDone();
            }}
          >
            Remove chain
          </Btn>
        ) : null}
      </div>
      {pendingBlocks ? (
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[#f2b544]">
          A destination change is already pending (panel 04). Proposing another replaces it.
        </p>
      ) : null}
      {checked && !checked.ok ? (
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[#ff3b30]">
          {checked.error}
        </p>
      ) : null}
    </div>
  );
}
