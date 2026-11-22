import { xebraWrapperAbi } from "@xebra/cctp-evm";
import { XEBRA_WRAPPERS, evmChainForDomain } from "@xebra/network-config";
import { http, type Address, createPublicClient, getAddress } from "viem";
import type { WrapperState } from "../../../lib/evm-wrapper";
import { logFailure } from "../../../lib/server/log";
import { readDomain } from "../../../lib/server/routes";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * The live settings of Xebra's fee wrapper on an EVM chain: whether it is paused, its fee and
 * transfer range, and each destination's caps. They change only through the contract's 48-hour
 * timelock (or instantly, to tighten), so they are read here rather than pinned, and the page prices
 * a transfer from them before anyone signs (`planWrapperFee`).
 *
 * Only a pinned wrapper is read (`XEBRA_WRAPPERS`), and only after it reports the USDC, Circle
 * messenger and CCTP domain the chain table pins: a wrapper pointed anywhere else is refused here,
 * so the page never offers it.
 *
 * `?src=<CCTP domain>`. Public, and cached for thirty seconds per chain.
 */

export const dynamic = "force-dynamic";

const cached = createTtlCache<WrapperState | { error: string }>(30_000);

export async function GET(request: Request): Promise<Response> {
  const src = readDomain(new URL(request.url).searchParams.get("src"));
  const chain = src === null ? null : evmChainForDomain(src);
  const address = chain ? XEBRA_WRAPPERS[chain.id] : undefined;
  if (!chain || !address) {
    return Response.json({ error: "no Xebra wrapper on that chain" }, { status: 404 });
  }

  const state = await cached(chain.id, async () => {
    const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 8_000 }) });
    const read = <T>(
      functionName:
        | "paused"
        | "getParams"
        | "getDomains"
        | "usdc"
        | "tokenMessenger"
        | "localDomain",
    ) =>
      client.readContract({
        address: address as Address,
        abi: xebraWrapperAbi,
        functionName,
      }) as Promise<T>;
    const [usdc, messenger, domain, paused, params, domains] = await Promise.all([
      read<Address>("usdc"),
      read<Address>("tokenMessenger"),
      read<number>("localDomain"),
      read<boolean>("paused"),
      read<{
        feeBps: number;
        minFee: bigint;
        minTransfer: bigint;
        maxTransfer: bigint;
        maxFastFeeBps: number;
      }>("getParams"),
      read<
        ReadonlyArray<{
          domain: number;
          evmStyle: boolean;
          maxForwardFee: bigint;
          accountCreation: boolean;
          maxForwardFeeNewAccount: bigint;
        }>
      >("getDomains"),
    ]);
    if (
      getAddress(usdc) !== getAddress(chain.usdcAddress) ||
      getAddress(messenger) !== getAddress(chain.tokenMessengerAddress) ||
      domain !== chain.cctpDomainId
    ) {
      return { error: `the wrapper on ${chain.name} does not point at Circle's pinned contracts` };
    }
    return {
      address,
      paused,
      params: {
        feeBps: params.feeBps,
        minFee: params.minFee.toString(),
        minTransfer: params.minTransfer.toString(),
        maxTransfer: params.maxTransfer.toString(),
        maxFastFeeBps: params.maxFastFeeBps,
      },
      domains: domains.map((d) => ({
        domain: d.domain,
        evmStyle: d.evmStyle,
        maxForwardFee: d.maxForwardFee.toString(),
        accountCreation: d.accountCreation,
        maxForwardFeeNewAccount: d.maxForwardFeeNewAccount.toString(),
      })),
    } satisfies WrapperState;
  }).catch((err: unknown) => {
    logFailure("/api/evm-wrapper", err, { chain: chain.id, src }, request);
    return { error: "could not read the wrapper" };
  });

  return Response.json(state, {
    status: "error" in state ? 502 : 200,
    headers: { "cache-control": "no-store" },
  });
}
