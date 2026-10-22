import type { CircleHealth } from "@xebra/cctp-client";
import { formatUsdc } from "../cctp-bridge";
import { buildDeepLink } from "../deep-link";
import { type Destination, STELLAR_CCTP_DOMAIN, stellarDestination } from "../destinations";
import { checkAddressOn } from "../evm-address";
import {
  EVM_CHAINS,
  type EnabledRoutes,
  type EvmChainId,
  type RouteDestinationId,
  evmDestinationsFrom,
  evmSources,
  isEvmChainId,
} from "../evm-chains";
import { planEvmFee } from "../evm-forward-fee";
import {
  type DomainForwardConfig,
  type FeeParams,
  chooseMaxFee,
  forwardBoundHolds,
  minimumForwardedAmount,
  suggestedMinimum,
  withTableCeiling,
} from "../forward-fee";
import { feeDestination, routeDestination } from "../route-destination";
import { checkSolanaAddress } from "../solana-address";
import { formatUsdc6, parseUsdc6 } from "../usdc6";
import { type Tool, type ToolResult, toolError, toolOk } from "./protocol";

/**
 * The four tools. They find a route, price it, hand a person a link to sign it, and report how a
 * transfer is getting on. None of them moves money or holds a key: the link opens the bridge page
 * prefilled, and the person approves in their own wallet (`lib/deep-link.ts`).
 *
 * Everything that touches the network comes in through `Deps`, so the logic here is tested with
 * fakes and the real wiring (`lib/mcp/server.ts`) is one small file.
 */

type SourceId = "stellar" | EvmChainId;
type DestId = "solana" | EvmChainId;

export interface StellarRoutes {
  /** What the bridge page would offer for a send from Stellar right now. */
  destinations: Destination[];
  /** The wrapper's committed domains, or null when the contract could not be read. */
  domains: Map<number, DomainForwardConfig> | null;
}

export interface Deps {
  siteUrl: string;
  evmRoutes: EnabledRoutes;
  stellarRoutes(): Promise<StellarRoutes>;
  /** Circle's quote and health for a route, as `/api/circle-health` answers it. Null if unreadable. */
  circle(src: number, dst: number): Promise<CircleHealth | null>;
  /** The wrapper's fee and floor. Null if unreadable. */
  feeParams(): Promise<FeeParams | null>;
  /** Circle's account of a burn, as `/api/delivery` answers it. */
  delivery(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const SOURCE_NAME = (id: SourceId): string => (id === "stellar" ? "Stellar" : EVM_CHAINS[id].name);
const DEST_NAME = (id: DestId): string => (id === "solana" ? "Solana" : EVM_CHAINS[id].name);

function readChain(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

const asSource = (raw: unknown): SourceId | null => {
  const v = readChain(raw);
  return v === "stellar" || isEvmChainId(v) ? v : null;
};
const asDest = (raw: unknown): DestId | null => {
  const v = readChain(raw);
  return v === "solana" || isEvmChainId(v) ? v : null;
};

interface Offered {
  from: SourceId;
  to: Array<{ id: DestId; name: string }>;
}

async function offered(deps: Deps): Promise<{ routes: Offered[]; committedKnown: boolean }> {
  const stellar = await deps.stellarRoutes();
  const routes: Offered[] = [
    {
      from: "stellar",
      to: stellar.destinations.map((d) => ({ id: d.id, name: d.name })),
    },
  ];
  for (const source of evmSources(deps.evmRoutes)) {
    routes.push({
      from: source,
      to: evmDestinationsFrom(source, deps.evmRoutes).map((id) => ({ id, name: DEST_NAME(id) })),
    });
  }
  return { routes, committedKnown: stellar.domains !== null };
}

const isOffered = (routes: Offered[], from: SourceId, to: DestId): boolean =>
  routes.find((r) => r.from === from)?.to.some((d) => d.id === to) ?? false;

const ROUTE_ARGS = {
  from: {
    type: "string",
    description:
      "Source chain id: 'stellar', or an EVM chain id such as 'arc'. Call list_routes for the ids.",
  },
  to: {
    type: "string",
    description: "Destination chain id, for example 'solana', 'base' or 'arbitrum'.",
  },
  amount: {
    type: "string",
    description:
      "Amount of USDC to send, as a decimal string with at most 6 places, for example '25.50'.",
  },
} as const;

function parseAmount(raw: unknown): bigint | string {
  if (typeof raw !== "string") return "amount must be a string such as '25.50'.";
  try {
    const units = parseUsdc6(raw);
    return units > 0n ? units : "amount must be greater than zero.";
  } catch (err) {
    return err instanceof Error ? err.message : "amount is not a valid USDC amount.";
  }
}

function routeProblem(
  routes: Offered[],
  fromRaw: unknown,
  toRaw: unknown,
): { from: SourceId; to: DestId } | ToolResult {
  const from = asSource(fromRaw);
  const to = asDest(toRaw);
  if (!from || !to) {
    return toolError(
      "from and to must be chain ids from list_routes (for example from 'stellar' to 'base').",
    );
  }
  if (!isOffered(routes, from, to)) {
    return toolError(
      `Xebra does not send from ${SOURCE_NAME(from)} to ${DEST_NAME(to)} right now. Call list_routes for what is live.`,
    );
  }
  return { from, to };
}

const isResult = (v: unknown): v is ToolResult =>
  typeof v === "object" && v !== null && "content" in v;

export function buildTools(deps: Deps): Tool[] {
  const listRoutes: Tool = {
    name: "list_routes",
    title: "List Xebra routes",
    description:
      "List every route Xebra can send native USDC on right now: each source chain and the destination chains it reaches. Xebra is a non-custodial bridge built on Circle CCTP: USDC is burned on the source chain and minted as native USDC on the destination, with no wrapped token. Call this first to learn the chain ids the other tools take.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async run() {
      const { routes, committedKnown } = await offered(deps);
      const lines = routes
        .filter((r) => r.to.length > 0)
        .map(
          (r) =>
            `From ${SOURCE_NAME(r.from)} (${r.from}) to: ${r.to.map((d) => `${d.name} (${d.id})`).join(", ")}`,
        );
      const note = committedKnown
        ? ""
        : "\nNote: the Stellar contract could not be read just now, so the Stellar list shows only Solana and Arc. More chains may be live; try again shortly.";
      return toolOk(
        `Xebra routes (native USDC, Circle CCTP):\n${lines.join("\n")}${note}\nTo send, use create_transfer_link and have the person open it and sign in their own wallet.`,
        { routes: routes.filter((r) => r.to.length > 0) },
      );
    },
  };

  const quoteTransfer: Tool = {
    name: "quote_transfer",
    title: "Quote a transfer",
    description:
      "Price a USDC transfer on a route: the fee, what the recipient receives, and whether Circle is healthy. Read-only, nothing is sent. Fees come out of the amount, so the recipient gets amount minus fee.",
    inputSchema: {
      type: "object",
      properties: ROUTE_ARGS,
      required: ["from", "to", "amount"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args) {
      const { routes } = await offered(deps);
      const route = routeProblem(routes, args.from, args.to);
      if (isResult(route)) return route;
      const units = parseAmount(args.amount);
      if (typeof units === "string") return toolError(units);

      const srcDomain =
        route.from === "stellar" ? STELLAR_CCTP_DOMAIN : EVM_CHAINS[route.from].cctpDomainId;
      const destDomain =
        route.to === "solana"
          ? stellarDestination("solana").domain
          : EVM_CHAINS[route.to].cctpDomainId;
      const health = await deps.circle(srcDomain, destDomain);
      if (!health || !health.quote) {
        return toolError(
          "Circle's delivery fee could not be read just now, so no price can be given. Try again shortly.",
        );
      }
      const status = {
        circle: health.status,
        ...(health.reasons.length > 0 ? { circleReasons: health.reasons } : {}),
      };
      if (health.status === "down") {
        return toolError(
          `Circle is not carrying transfers on this route right now (${health.reasons.join("; ") || "down"}). Do not start one.`,
        );
      }

      if (route.from === "stellar") {
        return quoteFromStellar(deps, route.to, units, health, status);
      }
      return quoteFromEvm(route.from, route.to, units, health, status);
    },
  };

  const createTransferLink: Tool = {
    name: "create_transfer_link",
    title: "Create a link to sign a transfer",
    description:
      "Return a xebra.exchange link that opens the bridge with the route, amount and recipient already filled in. The person opens it, checks the details and approves in their own wallet; Xebra never holds keys and the link cannot send anything by itself. Give the link to the user and tell them to check the recipient address. The recipient must be an address on the destination chain.",
    inputSchema: {
      type: "object",
      properties: {
        ...ROUTE_ARGS,
        recipient: {
          type: "string",
          description:
            "Address that receives the USDC on the destination chain: a 0x address for EVM chains, a wallet address for Solana. Optional; the person can fill it in on the page.",
        },
      },
      required: ["from", "to", "amount"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args) {
      const { routes } = await offered(deps);
      const route = routeProblem(routes, args.from, args.to);
      if (isResult(route)) return route;
      const units = parseAmount(args.amount);
      if (typeof units === "string") return toolError(units);

      let recipient: string | undefined;
      if (args.recipient !== undefined && args.recipient !== "") {
        if (typeof args.recipient !== "string") return toolError("recipient must be a string.");
        recipient = args.recipient.trim();
        const check = checkRecipient(route.to, recipient);
        if (!check.ok) {
          return toolError(
            `That is not a valid ${DEST_NAME(route.to)} address${check.error ? `: ${check.error}` : "."}`,
          );
        }
      }

      const amount = formatUsdc6(units).replace(/,/g, "");
      const url = buildDeepLink(deps.siteUrl, {
        from: route.from,
        to: route.to,
        amount,
        ...(recipient ? { recipient } : {}),
      });
      return toolOk(
        `Open this link to review and sign the transfer in your own wallet: ${url}\nIt sends ${amount} USDC from ${SOURCE_NAME(route.from)} to ${DEST_NAME(route.to)}${recipient ? ` for ${recipient}` : ""}. Check the amount and recipient on the page before approving. A transfer cannot be reversed once signed.`,
        { url, from: route.from, to: route.to, amount, ...(recipient ? { recipient } : {}) },
      );
    },
  };

  const getTransferStatus: Tool = {
    name: "get_transfer_status",
    title: "Check a transfer's status",
    description:
      "Report how a transfer is getting on, from Circle, given the transaction hash of the burn on the source chain. States include waiting, forwarding, delivered and claimable (delivery failed and the recipient can claim it at xebra.exchange/claim).",
    inputSchema: {
      type: "object",
      properties: {
        tx: {
          type: "string",
          description:
            "Transaction hash of the transfer on the source chain: 64 hex characters for Stellar, 0x plus 64 hex for an EVM chain.",
        },
        from: {
          type: "string",
          description: "Source chain id the transaction was sent on. Defaults to 'stellar'.",
        },
      },
      required: ["tx"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args) {
      const from = args.from === undefined ? "stellar" : asSource(args.from);
      if (!from) return toolError("from must be a chain id from list_routes.");
      const tx = typeof args.tx === "string" ? args.tx.trim().toLowerCase() : "";
      const kind = from === "stellar" ? /^[0-9a-f]{64}$/ : /^0x[0-9a-f]{64}$/;
      if (!kind.test(tx)) {
        return toolError(
          from === "stellar"
            ? "tx must be 64 hex characters, without 0x."
            : "tx must be 0x followed by 64 hex characters.",
        );
      }
      const domain = from === "stellar" ? STELLAR_CCTP_DOMAIN : EVM_CHAINS[from].cctpDomainId;
      const answer = await deps.delivery(tx, domain);
      if (!answer || answer.status === "unknown") {
        return toolError(
          "Circle's status could not be read just now. That does not mean the transfer failed. Try again shortly.",
        );
      }
      const state = String(answer.state ?? "unknown");
      const forwardTxHash = typeof answer.forwardTxHash === "string" ? answer.forwardTxHash : null;
      // Circle's own words, shown as data: short, and nothing is done with them.
      const reason = typeof answer.reason === "string" ? answer.reason.slice(0, 200) : null;
      const claim = `${deps.siteUrl.replace(/\/+$/, "")}/claim?tx=${tx}${from === "stellar" ? "" : `&src=${domain}`}`;
      return toolOk(
        `Transfer ${tx} from ${SOURCE_NAME(from)}: ${state}${forwardTxHash ? `, delivered in ${forwardTxHash}` : ""}.${state === "claimable" || state === "failed" ? ` Delivery did not complete on its own; the recipient can claim it at ${claim}.` : ""}`,
        { from, tx, state, forwardTxHash, reason },
      );
    },
  };

  return [listRoutes, quoteTransfer, createTransferLink, getTransferStatus];
}

function checkRecipient(to: DestId, address: string): { ok: boolean; error?: string | undefined } {
  if (to === "solana") return checkSolanaAddress(address);
  return checkAddressOn(EVM_CHAINS[to], address);
}

type Status = { circle: string; circleReasons?: string[] };

async function quoteFromStellar(
  deps: Deps,
  to: DestId,
  units: bigint,
  health: CircleHealth,
  status: Status,
): Promise<ToolResult> {
  const dest = stellarDestination(to);
  const [{ domains }, params] = await Promise.all([deps.stellarRoutes(), deps.feeParams()]);
  if (!params) {
    return toolError(
      "The bridge contract's fee schedule could not be read just now. Try again shortly.",
    );
  }
  // The contract's caps for this chain, lowered to the table's ceiling. If the contract cannot be
  // read, only the table's ceiling applies here and the page checks the rest at signing.
  const committed = domains?.get(dest.domain);
  if (domains && !committed) {
    return toolError(`The bridge contract does not send to ${dest.name} yet.`);
  }
  const cfg = withTableCeiling(
    committed ?? {
      forward: true,
      maxForwardFee: BigInt(Number.MAX_SAFE_INTEGER),
      accountCreation: true,
      maxForwardFeeNewAccount: BigInt(Number.MAX_SAFE_INTEGER),
    },
    dest.evm?.maxForwardFeeUnits ?? null,
  );
  const choice = chooseMaxFee({
    quote: health.quote as NonNullable<CircleHealth["quote"]>,
    needsAccount: false,
    cfg,
    destinationName: dest.name,
  });
  if (!choice.ok) return toolError(choice.reason);

  const amount = units * 10n; // 6-decimal units to the contract's 7-decimal stroops
  const m = choice.maxFee;
  if (!forwardBoundHolds(amount, m, params)) {
    const minimum = suggestedMinimum(minimumForwardedAmount(m, params));
    return toolError(
      `Fees would take more than a tenth of this transfer. Send at least ${formatUsdc(minimum)} USDC to ${dest.name}.`,
    );
  }
  // The contract's split: our fee is the largest of the percentage, the floor and Circle's fee; what
  // is burned is what remains after our share, floored to a whole unit; Circle keeps `m` of that.
  const pct = (amount * params.feeBps) / 10_000n;
  const base = pct > params.minFee ? pct : params.minFee;
  const fee = base > m ? base : m;
  const after = amount - (fee - m);
  const burned = after - (after % 10n);
  const received = burned - m;

  const note =
    to === "solana"
      ? " If the recipient wallet has no USDC account yet, opening one costs Circle roughly twice as much more and the page shows that fee before signing."
      : "";
  return toolOk(
    `Sending ${formatUsdc(amount)} USDC from Stellar to ${dest.name}: total fee ${formatUsdc(fee)} USDC (Circle's delivery ${formatUsdc(m)}, Xebra ${formatUsdc(fee - m)}). The recipient receives about ${formatUsdc(received)} USDC. Circle status: ${health.status}.${note} Fees can move before signing; the page shows the final figure.`,
    {
      from: "stellar",
      to,
      sent: formatUsdc(amount),
      fee: formatUsdc(fee),
      circleDeliveryFee: formatUsdc(m),
      xebraFee: formatUsdc(fee - m),
      recipientReceives: formatUsdc(received),
      speed: "standard",
      ...status,
    },
  );
}

function quoteFromEvm(
  from: EvmChainId,
  to: DestId,
  units: bigint,
  health: CircleHealth,
  status: Status,
): ToolResult {
  const dest = routeDestination(to as RouteDestinationId);
  const out: Array<{ speed: string; fee: string; received: string }> = [];
  const lines: string[] = [];
  const tiers = [
    ["standard", health.tiers.standard],
    ["fast", EVM_CHAINS[from].fast ? health.tiers.fast : null],
  ] as const;
  for (const [speed, tier] of tiers) {
    if (!tier) continue;
    const plan = planEvmFee({ amount: units, tier, destination: feeDestination(dest, false) });
    if (!plan.ok) {
      lines.push(`${speed}: ${plan.reason}`);
      continue;
    }
    out.push({ speed, fee: formatUsdc6(plan.fee), received: formatUsdc6(plan.received) });
    lines.push(
      `${speed}: fee ${formatUsdc6(plan.fee)} USDC, recipient receives about ${formatUsdc6(plan.received)} USDC`,
    );
  }
  if (lines.length === 0) {
    return toolError("Circle's delivery fee could not be read just now. Try again shortly.");
  }
  return toolOk(
    `Sending ${formatUsdc6(units)} USDC from ${EVM_CHAINS[from].name} to ${dest.name}:\n${lines.join("\n")}\nCircle status: ${health.status}. Fees can move before signing; the page shows the final figure.`,
    { from, to, sent: formatUsdc6(units), options: out, ...status },
  );
}
