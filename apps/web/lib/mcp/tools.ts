import {
  EVM_CHAINS,
  type EvmChainId,
  buildDeepLink,
  checkAddressOn,
  checkSolanaAddress,
  formatUsdc,
  formatUsdc6,
  isEvmChainId,
  parseUsdc6,
} from "@xebra/sdk/core";
import type { Deps } from "../api/deps";
import { ApiError } from "../api/errors";
import { type QuoteOption, createService } from "../api/service";
import { type Tool, type ToolResult, toolError, toolOk } from "./protocol";

export type { Deps, StellarRoutes } from "../api/deps";

/**
 * The four tools. They find a route, price it, hand a person a link to sign it, and report how a
 * transfer is getting on. None of them moves money or holds a key: the link opens the bridge page
 * prefilled, and the person approves in their own wallet (`packages/sdk/src/core/deep-link.ts`).
 *
 * Everything that touches the network comes in through `Deps`, so the logic here is tested with
 * fakes and the real wiring (`lib/mcp/server.ts`) is one small file.
 */

type SourceId = "stellar" | EvmChainId;
type DestId = "solana" | EvmChainId;

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

async function routeProblem(
  service: ReturnType<typeof createService>,
  fromRaw: unknown,
  toRaw: unknown,
): Promise<{ from: SourceId; to: DestId } | ToolResult> {
  const from = asSource(fromRaw);
  const to = asDest(toRaw);
  if (!from || !to) {
    return toolError(
      "from and to must be chain ids from list_routes (for example from 'stellar' to 'base').",
    );
  }
  try {
    await service.checkRoute(from, to);
  } catch (err) {
    if (err instanceof ApiError)
      return toolError(`${err.detail} Call list_routes for what is live.`);
    throw err;
  }
  return { from, to };
}

const isResult = (v: unknown): v is ToolResult =>
  typeof v === "object" && v !== null && "content" in v;

export function buildTools(deps: Deps): Tool[] {
  const service = createService(deps);
  const listRoutes: Tool = {
    name: "list_routes",
    title: "List Xebra routes",
    description:
      "List every route Xebra can send native USDC on right now: each source chain and the destination chains it reaches. Xebra is a non-custodial bridge built on Circle CCTP: USDC is burned on the source chain and minted as native USDC on the destination, with no wrapped token. Call this first to learn the chain ids the other tools take.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async run() {
      const { routes: groups, stellarContractRead } = await service.routes();
      // These tools hand out links to the bridge page, which sends from Stellar and the EVM chains.
      // Sui has a page of its own, and a link cannot name Aptos yet, so neither is offered here.
      const routes = groups
        .filter((g) => g.from !== "sui" && g.from !== "aptos")
        .map((g) => ({ from: g.from, to: g.to.map((d) => ({ id: d.id, name: d.name })) }));
      const lines = routes
        .filter((r) => r.to.length > 0)
        .map(
          (r) =>
            `From ${service.SOURCE_NAME(r.from)} (${r.from}) to: ${r.to.map((d) => `${d.name} (${d.id})`).join(", ")}`,
        );
      const note = stellarContractRead
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
      const route = await routeProblem(service, args.from, args.to);
      if (isResult(route)) return route;
      const units = parseAmount(args.amount);
      if (typeof units === "string") return toolError(units);

      let priced: Awaited<ReturnType<typeof service.quoteOptions>>;
      try {
        priced = await service.quoteOptions({ from: route.from, to: route.to, amount: units });
      } catch (err) {
        if (err instanceof ApiError) return toolError(err.detail);
        throw err;
      }
      const { health, options } = priced;
      const status = {
        circle: health?.status ?? "ok",
        ...(health && health.reasons.length > 0 ? { circleReasons: health.reasons } : {}),
      };
      if (route.from === "stellar") return stellarAnswer(route.to, options[0], status);
      return evmAnswer(route.from, route.to, units, options, status);
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
      const route = await routeProblem(service, args.from, args.to);
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
      let status: Awaited<ReturnType<typeof service.transferStatus>>;
      try {
        status = await service.transferStatus({ chain: from, tx });
      } catch (err) {
        if (err instanceof ApiError) return toolError(err.detail);
        throw err;
      }
      const { circleState: state, deliveryTx: forwardTxHash, reason, claimUrl } = status;
      return toolOk(
        `Transfer ${tx} from ${SOURCE_NAME(from)}: ${state}${forwardTxHash ? `, delivered in ${forwardTxHash}` : ""}.${claimUrl ? ` Delivery did not complete on its own; the recipient can claim it at ${claimUrl}.` : ""}`,
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

function stellarAnswer(to: DestId, option: QuoteOption | undefined, status: Status): ToolResult {
  if (!option)
    return toolError("Circle's delivery fee could not be read just now. Try again shortly.");
  if (!option.ok) return toolError(option.error.detail);
  const figures = option.priced.stellar;
  if (!figures) throw new Error("a Stellar quote without the contract's figures");
  const { amount, fee, deliveryFee: m, received } = figures;
  const name = DEST_NAME(to);
  const note =
    to === "solana"
      ? " If the recipient wallet has no USDC account yet, opening one costs Circle roughly twice as much more and the page shows that fee before signing."
      : "";
  return toolOk(
    `Sending ${formatUsdc(amount)} USDC from Stellar to ${name}: total fee ${formatUsdc(fee)} USDC (Circle's delivery ${formatUsdc(m)}, Xebra ${formatUsdc(fee - m)}). The recipient receives about ${formatUsdc(received)} USDC. Circle status: ${status.circle}.${note} Fees can move before signing; the page shows the final figure.`,
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

function evmAnswer(
  from: EvmChainId,
  to: DestId,
  units: bigint,
  options: QuoteOption[],
  status: Status,
): ToolResult {
  const out: Array<{ speed: string; fee: string; received: string }> = [];
  const lines: string[] = [];
  for (const option of options) {
    if (!option.ok) {
      lines.push(`${option.speed}: ${option.error.detail}`);
      continue;
    }
    const plan = option.priced.evm;
    if (!plan) throw new Error("an EVM quote without its fee plan");
    out.push({
      speed: option.speed,
      fee: formatUsdc6(plan.fee),
      received: formatUsdc6(plan.received),
    });
    lines.push(
      `${option.speed}: fee ${formatUsdc6(plan.fee)} USDC, recipient receives about ${formatUsdc6(plan.received)} USDC`,
    );
  }
  if (lines.length === 0) {
    return toolError("Circle's delivery fee could not be read just now. Try again shortly.");
  }
  return toolOk(
    `Sending ${formatUsdc6(units)} USDC from ${EVM_CHAINS[from].name} to ${DEST_NAME(to)}:\n${lines.join("\n")}\nCircle status: ${status.circle}. Fees can move before signing; the page shows the final figure.`,
    { from, to, sent: formatUsdc6(units), options: out, ...status },
  );
}
