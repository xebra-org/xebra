import { Connection, type Transaction } from "@solana/web3.js";
import { rpc } from "@stellar/stellar-sdk";
import type { CircleHealth } from "@xebra/cctp-client";
import { buildSuiBurn } from "@xebra/sdk/build";
import { type FeeParams, stellarDestinations } from "@xebra/sdk/core";
import { GET as attestation } from "../../app/api/attestation/route";
import { GET as circleHealth } from "../../app/api/circle-health/route";
import { GET as delivery } from "../../app/api/delivery/route";
import { GET as recipient } from "../../app/api/recipient/route";
import { GET as suiStatus } from "../../app/api/sui-stellar/status/route";
import { getWrapperDomains, getWrapperFeeParams } from "../cctp-bridge";
import { buildMintTransaction, prepareClaim } from "../claim";
import { env } from "../env";
import { getAllowance, getUsdcBalance6 } from "../evm-bridge";
import { checkClaim, isAlreadyMinted } from "../evm-claim";
import { createTtlCache } from "../server/ttl-cache";
import { suiClient } from "../sui-stellar/client";
import { maxUsdcBase, suiStellarEnabled } from "../sui-stellar/config";
import { planClaim, recipientStatus } from "../sui-stellar/stellar-side";
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
  async suiStatus(digest) {
    return readJsonAnyStatus(
      await suiStatus(
        new Request(`${ORIGIN}/api/sui-stellar/status?digest=${encodeURIComponent(digest)}`),
      ),
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
    async attestation(tx, srcDomain) {
      return readJsonAnyStatus(
        await attestation(new Request(`${ORIGIN}/api/attestation?tx=${tx}&src=${srcDomain}`)),
      );
    },
    async evmClaimCheck(chain, payer, message, signed) {
      const provider = rpcProvider(chain.rpcUrl);
      const target = { messageTransmitter: chain.messageTransmitterAddress };
      if (await isAlreadyMinted(provider, target, message)) return { state: "delivered" };
      const check = await checkClaim(provider, target, payer, message, signed);
      if (check.ok) return { state: "open" };
      return check.expired ? { state: "expired" } : { state: "refused", reason: check.reason };
    },
    async solanaClaim(input) {
      const connection = new Connection(env.solanaRpcUrl, { commitment: "confirmed" });
      const prep = await prepareClaim(connection, input);
      if (prep.status === "already-minted") return { state: "delivered" };
      if (prep.status === "needs-owner") return { state: "needs-owner", reason: prep.reason };
      const mint = await buildMintTransaction(connection, input);
      return {
        state: "ready",
        setup: prep.setup ? unsigned(prep.setup) : null,
        mint: unsigned(mint),
      };
    },
    suiClaim: (digest, payer) => planClaim(digest, payer),
  },
};

/** A Solana transaction for the wallet to sign: serialized with no signatures, base64. */
function unsigned(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/**
 * The route's JSON whatever its status: these routes answer `{ status: "unknown", ... }` with a 5xx
 * when Circle could not be asked, and the service reads that body, not the status code.
 */
async function readJsonAnyStatus(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
