import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { FORWARD_HOOK, addressToBytes32 } from "@xebra/cctp-evm";
import {
  STELLAR_DOMAIN,
  burnDestinationCaller,
  forwarderAsSuiAddress,
  stellarForwardHook,
} from "../core/cctp/sui-stellar.js";
import type { TransferStep } from "./types.js";

/**
 * Builds the Sui side of a transfer: Circle's CCTP V2 `deposit_for_burn` (to Stellar, domain 27, or
 * to an EVM chain through Circle's Forwarding Service), then the
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
/**
 * Standard finality on every route from Sui. Sui finalises in about a second, so Fast buys nothing,
 * and Circle quotes no transfer fee for Standard.
 */
const STANDARD_FINALITY = 2000;
const ZERO_ADDRESS = "0x0";

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

/** Sui to Stellar: the serialized burn for the wallet to sign. */
export function buildBurn(
  client: SuiGrpcClient,
  p: { sender: string; amount: bigint; stellarRecipient: string },
): Promise<{ transaction: string }> {
  return burnTransaction(client, {
    sender: p.sender,
    amount: p.amount,
    destinationDomain: STELLAR_DOMAIN,
    mintRecipient: forwarderAsSuiAddress(),
    // destinationCaller = the forwarder, as Circle requires. Zero would let anyone call
    // receive_message directly and strand the USDC in the forwarder. Relaying and self-claim
    // still work: they go through mint_and_forward, which anyone may call.
    destinationCaller: burnDestinationCaller(),
    maxFee: 0n,
    hookData: stellarForwardHook(p.stellarRecipient),
  });
}

/**
 * Sui to an EVM chain, delivered by Circle's Forwarding Service: the recipient is the
 * `mintRecipient`, the hook is Circle's `cctp-forward` request, and `maxFee` pays Circle for the
 * delivery (Circle keeps all of it). `destinationCaller` is zero, as Circle's forwarder requires,
 * which also keeps a failed delivery claimable by anyone.
 *
 * The caller has already validated the recipient for that chain and priced `maxFee`.
 */
export function buildEvmBurn(
  client: SuiGrpcClient,
  p: {
    sender: string;
    amount: bigint;
    evmRecipient: string;
    destinationDomain: number;
    maxFee: bigint;
  },
): Promise<{ transaction: string }> {
  if (p.maxFee <= 0n || p.maxFee >= p.amount) {
    throw new Error("maxFee must be above zero and below the amount");
  }
  return burnTransaction(client, {
    sender: p.sender,
    amount: p.amount,
    destinationDomain: p.destinationDomain,
    mintRecipient: addressToBytes32(p.evmRecipient),
    destinationCaller: ZERO_ADDRESS,
    maxFee: p.maxFee,
    hookData: hexToBytes(FORWARD_HOOK),
  });
}

/** Without Buffer, so this runs in a browser bundle as it is. */
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface BurnArgs {
  sender: string;
  amount: bigint;
  destinationDomain: number;
  /** 32 bytes as a Sui address argument. */
  mintRecipient: string;
  destinationCaller: string;
  maxFee: bigint;
  hookData: Uint8Array;
}

async function burnTransaction(
  client: SuiGrpcClient,
  p: BurnArgs,
): Promise<{ transaction: string }> {
  // Both kinds of holding count: coin objects, and the address balance Sui now keeps per account
  // (a wallet can hold all of its USDC there and no coins at all). The SDK's `coinWithBalance`
  // draws from either and merges as needed; this check only gives a clear refusal first.
  const { balance } = await client.core.getBalance({ owner: p.sender, coinType: CFG.usdcType });
  const have = BigInt(balance.balance);
  if (have < p.amount) throw new InsufficientUsdcError(have, p.amount);

  const tx = new Transaction();
  tx.setSender(p.sender);
  const coin = tx.add(
    coinWithBalance({ type: CFG.usdcType, balance: p.amount, useGasCoin: false }),
  );

  const [receipt, returned] = must2(
    tx.moveCall({
      target: `${CFG.tmmV2PackageId}::deposit_for_burn::deposit_for_burn`,
      arguments: [
        coin,
        tx.pure.u32(p.destinationDomain),
        tx.pure.address(p.mintRecipient),
        tx.pure.address(p.destinationCaller),
        tx.pure.u256(p.maxFee),
        tx.pure.u32(STANDARD_FINALITY),
        tx.pure.vector("u8", Array.from(p.hookData)),
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

/** `buildBurn` as the step a wallet signs. */
export async function buildSuiBurn(
  client: SuiGrpcClient,
  p: { sender: string; amount: bigint; stellarRecipient: string },
): Promise<TransferStep> {
  const { transaction } = await buildBurn(client, p);
  return {
    id: "burn",
    chain: "sui",
    description: "Burn USDC on Sui; Circle attests it and it is minted to the Stellar recipient.",
    tx: { kind: "sui", json: transaction },
    expiresAt: null,
  };
}
