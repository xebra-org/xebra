import { rpc } from "@stellar/stellar-sdk";
import type { CircleHealth } from "@xebra/cctp-client";
import { buildSuiBurn } from "@xebra/sdk/build";
import { type FeeParams, stellarDestinations } from "@xebra/sdk/core";
import { GET as circleHealth } from "../../app/api/circle-health/route";
import { GET as delivery } from "../../app/api/delivery/route";
import { GET as recipient } from "../../app/api/recipient/route";
import { getWrapperDomains, getWrapperFeeParams } from "../cctp-bridge";
import { env } from "../env";
import { getAllowance, getUsdcBalance6 } from "../evm-bridge";
import { createTtlCache } from "../server/ttl-cache";
import { suiClient } from "../sui-stellar/client";
import { maxUsdcBase, suiStellarEnabled } from "../sui-stellar/config";
import { recipientStatus } from "../sui-stellar/stellar-side";
import type { Eip1193Provider } from "../wallets/types";
import type { Deps, StellarRoutes } from "./deps";

/**
 * The real dependencies of the service layer (`lib/api/service.ts`), shared by the public API and
 * the MCP tools: the same reads the bridge page makes, so every surface gives the same answer. The
 * Circle, delivery and Solana-recipient lookups call the site's own route handlers, which means the
 * same Iris budget, cache and rules apply.
 *
 * Nothing here signs or holds a key. Reads only.
 */

const SITE_URL = process.env.XEBRA_SITE_URL ?? "https://xebra.exchange";
/** The all-zero account: a valid address nobody holds, the source of a view call. */
const VIEW_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ORIGIN = "http://internal";

const routesCache = createTtlCache<StellarRoutes>(30_000);
const paramsCache = createTtlCache<FeeParams | null>(60_000);

async function stellarRoutes(): Promise<StellarRoutes> {
  return routesCache("stellar", async () => {
    let domains: StellarRoutes["domains"] = null;
    try {
      domains = await getWrapperDomains({
        wrapperContractId: env.cctpWrapperContractId,
        sorobanRpcUrl: env.sorobanRpcUrl,
        networkPassphrase: env.stellarNetworkPassphrase,
      });
    } catch {
      domains = null;
    }
    return {
      domains,
      destinations: stellarDestinations({
        arcEnabled: env.arcEnabled,
        sendsTo: env.stellarSendsTo,
        committed: domains ? new Set(domains.keys()) : null,
      }),
    };
  });
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const liveDeps: Deps = {
  siteUrl: SITE_URL,
  suiStellar: { enabled: suiStellarEnabled(), maxUnits: maxUsdcBase() },
  evmRoutes: env.evmRoutes,
  stellarRoutes,
  async circle(src, dst, newAccount) {
    const q = `src=${src}&dst=${dst}${newAccount ? "&newAccount=1" : ""}`;
    const body = await readJson(
      await circleHealth(new Request(`${ORIGIN}/api/circle-health?${q}`)),
    );
    return body ? (body as unknown as CircleHealth) : null;
  },
  feeParams: () =>
    paramsCache("params", async () => {
      try {
        return await getWrapperFeeParams(
          {
            horizonUrl: env.horizonUrl,
            wrapperContractId: env.cctpWrapperContractId,
            cctpTokenMessengerId: env.cctpTokenMessengerId,
            usdcSacAddress: env.usdcSacAddress,
            sorobanRpcUrl: env.sorobanRpcUrl,
            networkPassphrase: env.stellarNetworkPassphrase,
            destinationDomain: 0,
          },
          VIEW_SOURCE,
        );
      } catch {
        return null;
      }
    }),
  async delivery(tx, srcDomain) {
    return readJson(
      await delivery(new Request(`${ORIGIN}/api/delivery?tx=${tx}&src=${srcDomain}`)),
    );
  },
  build: {
    stellarRpc: () => new rpc.Server(env.sorobanRpcUrl),
    stellarWrapper: env.cctpWrapperContractId
      ? {
          wrapperContractId: env.cctpWrapperContractId,
          networkPassphrase: env.stellarNetworkPassphrase,
        }
      : null,
    stellarAccount: recipientStatus,
    async solanaRecipient(owner) {
      const body = await readJson(
        await recipient(new Request(`${ORIGIN}/api/recipient?owner=${encodeURIComponent(owner)}`)),
      );
      const status = body?.status;
      return {
        tokenAccount: typeof body?.tokenAccount === "string" ? body.tokenAccount : "",
        status: status === "exists" || status === "missing" ? status : "unknown",
      };
    },
    async evmUsdc(chain, owner, spender) {
      const provider = rpcProvider(chain.rpcUrl);
      const [balance, allowance] = await Promise.all([
        getUsdcBalance6(provider, chain, owner),
        getAllowance(provider, chain, owner, spender),
      ]);
      return { balance, allowance };
    },
    evmWrapperOn: env.arcUseWrapper,
    suiBurn: (p) => buildSuiBurn(suiClient(), p),
  },
};

/** A read-only EIP-1193 provider over the chain's public JSON-RPC, for balance and allowance. */
function rpcProvider(url: string): Eip1193Provider {
  let id = 0;
  return {
    async request({ method, params }) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`${method}: the RPC answered ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
      return body.result;
    },
  };
}
