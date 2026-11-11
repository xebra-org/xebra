import type { CircleHealth } from "@xebra/cctp-client";
import { type FeeParams, stellarDestinations } from "@xebra/sdk/core";
import { GET as circleHealth } from "../../app/api/circle-health/route";
import { GET as delivery } from "../../app/api/delivery/route";
import { getWrapperDomains, getWrapperFeeParams } from "../cctp-bridge";
import { env } from "../env";
import { createTtlCache } from "../server/ttl-cache";
import type { Server } from "./protocol";
import { type Deps, type StellarRoutes, buildTools } from "./tools";

/**
 * The real wiring of the MCP tools (`lib/mcp/tools.ts`): the same reads the bridge page makes, so
 * what an assistant is told is what the page would show. The Circle and delivery lookups call the
 * site's own route handlers, which means the same Iris budget, cache and route rules apply.
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

const deps: Deps = {
  siteUrl: SITE_URL,
  evmRoutes: env.evmRoutes,
  stellarRoutes,
  async circle(src, dst) {
    const body = await readJson(
      await circleHealth(new Request(`${ORIGIN}/api/circle-health?src=${src}&dst=${dst}`)),
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
};

export const server: Server = {
  info: { name: "xebra", title: "Xebra", version: "1.0.0" },
  instructions:
    "Xebra (xebra.exchange) is a non-custodial bridge for native USDC, built on Circle CCTP: USDC is burned on the source chain and minted as native USDC on the destination, with no wrapped token and no custody. Use list_routes to see what is live, quote_transfer to price a route, and create_transfer_link to give the user a link where they review and sign the transfer in their own wallet. You cannot send funds yourself and no tool signs anything; always tell the user to check the recipient address before approving. A transfer cannot be reversed once signed.",
  tools: buildTools(deps),
};
