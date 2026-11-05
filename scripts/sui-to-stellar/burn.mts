/**
 * Sui -> Stellar USDC burn over CCTP V2 (mainnet), built from Circle's own sui-cctp call sequence
 * (scripts/sui/ptbV2.ts: addDepositForBurnV2) and Parabola's Stellar hook encoding.
 *
 * Modes:
 *   dry   (default) Build the transaction and SIMULATE it as SENDER. Nothing is signed or sent.
 *                   SENDER only has to hold the USDC; no key is needed.
 *   build           Print the unsigned transaction as base64 for SENDER, so the owner can sign it in
 *                   their own wallet or with `sui keytool sign`. Their key never reaches this tool or
 *                   whoever runs it. This is the mode to use when the USDC belongs to someone else.
 *   send            Sign with SUI_SIGNER_KEY (suiprivkey...) and execute. Requires CONFIRM_MAINNET=yes.
 *
 * Env: SENDER, STELLAR_RECIPIENT (G... with a USDC trustline), AMOUNT (base units, 6 dp, default 1000000)
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { StrKey } from "@stellar/stellar-sdk";

// --- Circle CCTP V2 on Sui mainnet (developers.circle.com/cctp/references/sui-packages) ---------
const CFG = {
  tmmV2PackageId: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  tmmV2StateId: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
  mtV2StateId: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
  handlerPackageId: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
  handlerStateId: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
  treasuryId: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
  usdcType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
};
const DENY_LIST_ID = "0x403";

// --- Stellar side (mainnet), from @asctp/parabola's STELLAR_MAINNET -----------------------------
const STELLAR_DOMAIN = 27;
const STELLAR_CCTP_FORWARDER = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";

/** The forwarder is the on-chain mint recipient; the real recipient rides in the hook data. */
export function forwarderAsSuiAddress(): string {
  return `0x${Buffer.from(StrKey.decodeContract(STELLAR_CCTP_FORWARDER)).toString("hex")}`;
}

/**
 * Hook data the CctpForwarder reads: 32-byte header (version 0 at bytes 24..27, u32 BE length at
 * 28..31) followed by the recipient's StrKey as UTF-8 text. Same bytes as Parabola's
 * `encodeStellarForwardHook`.
 */
export function stellarForwardHook(recipient: string): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(recipient) && !StrKey.isValidContract(recipient)) {
    throw new Error(`Invalid Stellar address: ${recipient}`);
  }
  const body = Buffer.from(recipient, "utf8");
  const hook = Buffer.alloc(32 + body.length);
  hook.writeUInt32BE(0, 24);
  hook.writeUInt32BE(body.length, 28);
  body.copy(hook, 32);
  return hook;
}

/** Narrow a Move call's result tuple, which the SDK types as an array of possibly-missing items. */
function must1<T>(r: readonly T[]): [T] {
  if (r[0] === undefined) throw new Error("missing Move call result");
  return [r[0]];
}
function must2<T>(r: readonly T[]): [T, T] {
  if (r[0] === undefined || r[1] === undefined) throw new Error("missing Move call result");
  return [r[0], r[1]];
}

export async function buildBurn(
  client: SuiGrpcClient,
  p: {
    sender: string;
    amount: bigint;
    stellarRecipient: string;
  },
): Promise<Transaction> {
  // Prefer one coin that already covers the amount (no merges, small PTB). Otherwise merge coins
  // up to MAX_MERGE, which is plenty for a normal wallet.
  const MAX_MERGE = 200;
  const coins: { objectId: string; balance: string }[] = [];
  let single: { objectId: string; balance: string } | undefined;
  let cursor: string | null = null;
  do {
    const page = await client.core.listCoins({ owner: p.sender, coinType: CFG.usdcType, cursor });
    single = page.objects.find((c) => BigInt(c.balance) >= p.amount);
    if (single) break;
    coins.push(...page.objects);
    cursor = page.hasNextPage && coins.length < MAX_MERGE ? page.cursor : null;
  } while (cursor);

  const tx = new Transaction();
  tx.setSender(p.sender);
  let primary: TransactionObjectArgument;
  if (single) {
    primary = tx.object(single.objectId);
  } else {
    const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < p.amount)
      throw new Error(`Sender holds ${total} base units of USDC, need ${p.amount}`);
    const first = coins[0];
    if (!first) throw new Error("Sender holds no USDC coins");
    primary = tx.object(first.objectId);
    if (coins.length > 1)
      tx.mergeCoins(
        primary,
        coins.slice(1).map((c) => tx.object(c.objectId)),
      );
  }
  const [coin] = must1(tx.splitCoins(primary, [p.amount]));

  const [receipt, returned] = must2(
    tx.moveCall({
      target: `${CFG.tmmV2PackageId}::deposit_for_burn::deposit_for_burn`,
      arguments: [
        coin,
        tx.pure.u32(STELLAR_DOMAIN),
        tx.pure.address(forwarderAsSuiAddress()),
        tx.pure.address("0x0"), // destinationCaller: unrestricted, so any relayer can complete
        tx.pure.u256(0n), // maxFee: standard transfer
        tx.pure.u32(2000), // standard finality (Stellar: Fast Transfer N/A)
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
  return tx;
}

async function main() {
  const mode = process.env.MODE ?? "dry";
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://fullnode.mainnet.sui.io:443",
  });
  const amount = BigInt(process.env.AMOUNT ?? "1000000");
  const stellarRecipient = process.env.STELLAR_RECIPIENT;
  if (!stellarRecipient) throw new Error("STELLAR_RECIPIENT is required");

  let signer: Ed25519Keypair | null = null;
  let sender = process.env.SENDER;
  if (mode === "send") {
    if (process.env.CONFIRM_MAINNET !== "yes") throw new Error("send needs CONFIRM_MAINNET=yes");
    signer = Ed25519Keypair.fromSecretKey(process.env.SUI_SIGNER_KEY ?? "");
    sender = signer.toSuiAddress();
  }
  if (!sender) throw new Error("SENDER is required");

  console.log(`mode=${mode} sender=${sender}`);
  console.log(
    `burn ${amount} base units -> domain ${STELLAR_DOMAIN}, forwarder ${STELLAR_CCTP_FORWARDER}`,
  );
  console.log(`  mintRecipient (bytes32) ${forwarderAsSuiAddress()}`);
  console.log(`  hookData ${Buffer.from(stellarForwardHook(stellarRecipient)).toString("hex")}`);

  const tx = await buildBurn(client, { sender, amount, stellarRecipient });

  if (mode === "build") {
    const bytes = await tx.build({ client });
    console.log(`unsigned transaction (base64):\n${Buffer.from(bytes).toString("base64")}`);
    console.log(
      "\nSign it with the sender's wallet, or: sui keytool sign --address <sender> --data <base64>\n" +
        "then submit the result with: sui client execute-signed-tx --tx-bytes <base64> --signatures <sig>",
    );
    return;
  }

  if (mode === "send") {
    if (!signer) throw new Error("no signer");
    const res = await client.core.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { effects: true, events: true },
    });
    console.log(JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }

  const sim = await client.core.simulateTransaction({
    transaction: tx,
    include: { effects: true, events: true },
  });
  console.log(JSON.stringify(sim, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
