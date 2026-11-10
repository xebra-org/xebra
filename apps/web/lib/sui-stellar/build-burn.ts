import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import {
  STELLAR_DOMAIN,
  burnDestinationCaller,
  forwarderAsSuiAddress,
  stellarForwardHook,
} from "./cctp";
import { suiRpcUrl } from "./config";

/**
 * Builds the Sui side of the transfer: Circle's CCTP V2 `deposit_for_burn` to domain 27, then the
 * two calls that settle the burn (`handler::burn`, `complete_burn`). The sequence is Circle's own
 * (sui-cctp `addDepositForBurnV2`); the IDs are from developers.circle.com/cctp/references/sui-packages
 * and were checked against mainnet on 2026-11-05.
 *
 * The transaction is built here and signed in the user's wallet. Nothing on the server ever holds a
 * Sui key, and the browser never needs a Sui RPC of its own.
 */
const CFG = {
  tmmV2PackageId: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  tmmV2StateId: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
  mtV2StateId: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
  handlerPackageId: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
  handlerStateId: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
  treasuryId: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
  usdcType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
} as const;

const DENY_LIST_ID = "0x403";
/** Stellar has no Fast Transfer; standard finality, no fee. */
const STANDARD_FINALITY = 2000;
/** A wallet with thousands of dust coins should still produce a small transaction. */
const MAX_COINS_MERGED = 200;

export const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

export class InsufficientUsdcError extends Error {
  constructor(
    readonly have: bigint,
    readonly need: bigint,
  ) {
    super("This Sui address does not hold enough USDC.");
  }
}

function must1<T>(r: readonly T[]): [T] {
  if (r[0] === undefined) throw new Error("missing Move call result");
  return [r[0]];
}

function must2<T>(r: readonly T[]): [T, T] {
  if (r[0] === undefined || r[1] === undefined) throw new Error("missing Move call result");
  return [r[0], r[1]];
}

export function suiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: "mainnet", baseUrl: suiRpcUrl() });
}

/** The serialized transaction for the wallet to sign, plus the sender's USDC balance for the UI. */
export async function buildBurn(
  client: SuiGrpcClient,
  p: { sender: string; amount: bigint; stellarRecipient: string },
): Promise<{ transaction: string }> {
  const coins: { objectId: string; balance: string }[] = [];
  let single: { objectId: string; balance: string } | undefined;
  let cursor: string | null = null;
  do {
    const page = await client.core.listCoins({
      owner: p.sender,
      coinType: CFG.usdcType,
      cursor,
    });
    single = page.objects.find((c) => BigInt(c.balance) >= p.amount);
    if (single) break;
    coins.push(...page.objects);
    cursor = page.hasNextPage && coins.length < MAX_COINS_MERGED ? page.cursor : null;
  } while (cursor);

  const tx = new Transaction();
  tx.setSender(p.sender);

  let primary: TransactionObjectArgument;
  if (single) {
    primary = tx.object(single.objectId);
  } else {
    const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
    const first = coins[0];
    if (!first || total < p.amount) throw new InsufficientUsdcError(total, p.amount);
    primary = tx.object(first.objectId);
    if (coins.length > 1) {
      tx.mergeCoins(
        primary,
        coins.slice(1).map((c) => tx.object(c.objectId)),
      );
    }
  }
  const [coin] = must1(tx.splitCoins(primary, [p.amount]));

  const [receipt, returned] = must2(
    tx.moveCall({
      target: `${CFG.tmmV2PackageId}::deposit_for_burn::deposit_for_burn`,
      arguments: [
        coin,
        tx.pure.u32(STELLAR_DOMAIN),
        tx.pure.address(forwarderAsSuiAddress()),
        // destinationCaller = the forwarder, as Circle requires. Zero would let anyone call
        // receive_message directly and strand the USDC in the forwarder. Relaying and self-claim
        // still work: they go through mint_and_forward, which anyone may call.
        tx.pure.address(burnDestinationCaller()),
        tx.pure.u256(0n),
        tx.pure.u32(STANDARD_FINALITY),
        tx.pure.vector("u8", Array.from(stellarForwardHook(p.stellarRecipient))),
        tx.object(CFG.tmmV2StateId),
      ],
      typeArguments: [CFG.usdcType],
    }),
  );
  const [ticket] = must1(
    tx.moveCall({
      target: `${CFG.handlerPackageId}::handler::burn`,
      arguments: [
        tx.object(CFG.handlerStateId),
        receipt,
        returned,
        tx.object(DENY_LIST_ID),
        tx.object(CFG.treasuryId),
      ],
    }),
  );
  tx.moveCall({
    target: `${CFG.tmmV2PackageId}::deposit_for_burn::complete_burn`,
    arguments: [ticket, tx.object(CFG.tmmV2StateId), tx.object(CFG.mtV2StateId)],
    typeArguments: [CFG.usdcType, `${CFG.handlerPackageId}::handler::Auth`],
  });

  // Resolved against the node so the wallet gets object versions and a gas budget, not a recipe.
  return { transaction: await tx.toJSON({ client }) };
}
