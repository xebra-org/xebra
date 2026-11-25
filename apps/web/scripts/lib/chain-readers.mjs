/**
 * Read-only readers of Xebra's transfers, straight from each chain's public endpoints. No keys.
 *
 * Two kinds of proof, depending on the route:
 *   - Through a Xebra contract (Stellar, Arc): the contract's own `BridgeInitiated` event.
 *   - Without one (Solana, Sui, other EVM chains): the payment into Xebra's fee address. On Solana
 *     and Sui it is in the same transaction as Circle's burn, which this checks; on EVM chains it is
 *     its own transaction, tagged with Xebra's ERC-8021 code (`isXebraTagged`).
 *
 * Every reader takes a cursor and returns `{ found, cursor }` so a run only reads what is new.
 * Used by `transfers-record.mjs` and `near-intents-volume.mjs`.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";

// Node gives each address 250 ms before trying the next; on a slow link that fails hosts that work.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

export const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
export const STELLAR_RPC = process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com";
export const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const SUI_GRAPHQL = process.env.SUI_GRAPHQL_URL || "https://graphql.mainnet.sui.io/graphql";

export const ARC_WRAPPER = "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3";
/** The Arc wrapper's first `BridgeInitiated` (seq 1) is in block 31094669; nothing comes earlier. */
export const ARC_FIRST_BLOCK = 31_094_000n;
const ARC_LOG_SPAN = 5_000n; // the public RPC refuses wider eth_getLogs ranges
export const STELLAR_WRAPPER = "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR";

const SOLANA_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b1hiZbsiqAX8hTzUv78u8nG6m5HN");
/** Circle's TokenMessengerMinterV2 on Solana: the program whose instruction is the burn. */
const SOLANA_TOKEN_MESSENGER = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const SOLANA_MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const SUI_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_TOKEN_MESSENGER = "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830";

export const ARC_EVENT = parseAbiItem(
  "event BridgeInitiated(bytes32 indexed transferId, uint64 indexed seq, address indexed user, uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 fee, uint256 netBurned, uint256 forwardFee, uint256 wrapperTake, uint32 minFinalityThreshold, bytes32 recipientOwner)",
);
const TRANSFER_TOPIC = toEventSelector(
  parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
);

export const usdc = (units, decimals = 6) => Number(units) / 10 ** decimals;
export const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch, trying again (up to six times, backing off) when the network fails or the endpoint
 * rate-limits. Returns the response for anything else, errors included.
 */
export async function request(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt >= 6) throw e;
    }
    if (res && res.status !== 429) return res;
    if (res && attempt >= 6) return res;
    await sleep(1000 * 2 ** attempt);
  }
}

export async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json();
    if (!body.error) return body.result;
    // Arc's public RPC says "rate limit exceeded" in a 200.
    if (/rate limit/i.test(body.error.message) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${method}: ${body.error.message}`);
  }
}

// --- through Xebra's contracts ----------------------------------------------------------------

export async function arcTransfers(fromBlock) {
  const topic = toEventSelector(ARC_EVENT);
  const latest = BigInt(await rpc(ARC_RPC, "eth_blockNumber", []));
  const found = [];
  for (let a = fromBlock; a <= latest; a += ARC_LOG_SPAN) {
    await sleep(250);
    const b = a + ARC_LOG_SPAN - 1n < latest ? a + ARC_LOG_SPAN - 1n : latest;
    const logs = await rpc(ARC_RPC, "eth_getLogs", [
      {
        address: ARC_WRAPPER,
        topics: [topic],
        fromBlock: `0x${a.toString(16)}`,
        toBlock: `0x${b.toString(16)}`,
      },
    ]);
    for (const log of logs) {
      const { args } = decodeEventLog({ abi: [ARC_EVENT], data: log.data, topics: log.topics });
      const block = await rpc(ARC_RPC, "eth_getBlockByNumber", [log.blockNumber, false]);
      found.push({
        id: `arc:${args.transferId}`,
        source: "arc",
        proof: "contract",
        sourceTx: log.transactionHash,
        sourceTxUrl: `https://explorer.arc.io/tx/${log.transactionHash}`,
        at: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        sender: args.user,
        domain: Number(args.destinationDomain),
        mintRecipient: args.mintRecipient,
        recipientOwner: args.recipientOwner,
        amount: usdc(args.amount),
        xebraFee: usdc(args.wrapperTake),
        circleFee: usdc(args.forwardFee),
      });
    }
  }
  return { found, cursor: latest + 1n };
}

export async function stellarTransfers(cursorLedger) {
  const health = await rpc(STELLAR_RPC, "getHealth");
  let gap = null;
  let start = cursorLedger ?? health.oldestLedger;
  if (start < health.oldestLedger) {
    gap = { from: start, to: health.oldestLedger - 1 };
    start = health.oldestLedger;
  }
  const topic = xdr.ScVal.scvSymbol("bridge_initiated").toXDR("base64");
  const found = [];
  let page = { startLedger: start };
  // With no cursor this is the first read: note how far back the RPC let it go.
  let startedAt = null;
  for (;;) {
    const res = await rpc(STELLAR_RPC, "getEvents", {
      ...page,
      filters: [{ type: "contract", contractIds: [STELLAR_WRAPPER], topics: [[topic, "**"]] }],
      pagination: { limit: 200, ...(page.cursor ? { cursor: page.cursor } : {}) },
    });
    if (cursorLedger === undefined && startedAt === null && res.oldestLedgerCloseTime) {
      startedAt = new Date(Number(res.oldestLedgerCloseTime) * 1000).toISOString();
    }
    for (const e of res.events) {
      const v = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
      found.push({
        id: `stellar:${hex(v.transfer_id)}`,
        source: "stellar",
        proof: "contract",
        sourceTx: e.txHash,
        sourceTxUrl: `https://stellar.expert/explorer/public/tx/${e.txHash}`,
        at: e.ledgerClosedAt,
        sender: v.user,
        domain: Number(v.destination_domain),
        mintRecipient: hex(v.mint_recipient),
        recipientOwner: v.recipient_owner ? hex(v.recipient_owner) : null,
        amount: usdc(v.amount, 7),
        xebraFee: usdc(v.wrapper_take ?? 0, 7),
        circleFee: usdc(v.forward_fee ?? 0, 7),
      });
    }
    // The RPC scans a limited stretch of ledgers per call and hands back a cursor where it
    // stopped, events or not, so follow it to the latest ledger rather than stopping on a short page.
    const at = res.cursor ? Number(BigInt(res.cursor.split("-")[0]) >> 32n) : res.latestLedger;
    if (at >= res.latestLedger) break;
    page = { cursor: res.cursor };
  }
  return { found, cursor: health.latestLedger + 1, gap, startedAt };
}

// --- without a contract: Xebra's fee, paid beside Circle's burn ------------------------------

/** The USDC token account of a Solana wallet. */
export function solanaUsdcAccount(owner) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), SOLANA_USDC_MINT.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/**
 * Transactions that paid Xebra's fee on Solana and burned through Circle in the same transaction.
 * `untilSignature` is the newest one already recorded.
 */
export async function solanaFeeTransfers(feeOwner, untilSignature) {
  const account = solanaUsdcAccount(feeOwner).toBase58();
  const sigs = [];
  let before;
  for (;;) {
    const page = await rpc(SOLANA_RPC, "getSignaturesForAddress", [
      account,
      {
        limit: 1000,
        ...(before ? { before } : {}),
        ...(untilSignature ? { until: untilSignature } : {}),
      },
    ]);
    sigs.push(...page.filter((s) => !s.err));
    if (page.length < 1000) break;
    before = page.at(-1).signature;
  }
  const found = [];
  for (const { signature } of sigs.reverse()) {
    await sleep(250);
    const tx = await rpc(SOLANA_RPC, "getTransaction", [
      signature,
      { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "finalized" },
    ]);
    if (!tx) continue;
    const message = VersionedTransaction.deserialize(
      Buffer.from(tx.transaction[0], "base64"),
    ).message;
    const keys = [
      ...message.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    let burn = null;
    let tagged = false;
    for (const ix of message.compiledInstructions) {
      const program = keys[ix.programIdIndex];
      const data = Buffer.from(ix.data);
      // depositForBurnWithHook: 8-byte discriminator, amount u64, destination_domain u32, ...
      if (program === SOLANA_TOKEN_MESSENGER && data.length >= 20) {
        burn = { amount: data.readBigUInt64LE(8), domain: data.readUInt32LE(16) };
      }
      if (program === SOLANA_MEMO && data.toString("utf8") === "xebra") tagged = true;
    }
    if (!burn) continue; // USDC sent to the fee address some other way: not a transfer
    const balance = (list) =>
      BigInt(list?.find((b) => keys[b.accountIndex] === account)?.uiTokenAmount.amount ?? "0");
    const fee = balance(tx.meta.postTokenBalances) - balance(tx.meta.preTokenBalances);
    found.push({
      id: `solana:${signature}`,
      source: "solana",
      proof: "fee-in-burn",
      tagged,
      sourceTx: signature,
      sourceTxUrl: `https://solscan.io/tx/${signature}`,
      at: new Date(tx.blockTime * 1000).toISOString(),
      sender: keys[0],
      domain: burn.domain,
      amount: usdc(burn.amount + fee),
      xebraFee: usdc(fee),
      circleFee: null,
    });
  }
  return { found, cursor: sigs.length ? sigs.at(-1).signature : untilSignature };
}

const SUI_QUERY = `query($f: TransactionFilter, $after: String) {
  transactions(first: 50, after: $after, filter: $f) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest
      sender { address }
      effects { timestamp balanceChanges { nodes { owner { address } amount coinType { repr } } } }
      kind { ... on ProgrammableTransaction { commands(first: 30) { nodes {
        ... on MoveCallCommand { function { name module { name package { address } } } }
      } } } }
    }
  }
}`;

/** Transactions that paid Xebra's fee on Sui and burned through Circle in the same transaction. */
export async function suiFeeTransfers(feeAddress, afterCursor) {
  const fee = feeAddress.toLowerCase();
  const found = [];
  let after = afterCursor ?? null;
  for (;;) {
    const res = await request(SUI_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: SUI_QUERY, variables: { f: { affectedAddress: fee }, after } }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(`Sui GraphQL: ${body.errors[0].message}`);
    const page = body.data.transactions;
    for (const t of page.nodes) {
      const calls = t.kind?.commands?.nodes ?? [];
      const burned = calls.some(
        (c) =>
          c.function?.name === "deposit_for_burn" &&
          c.function.module?.package?.address === SUI_TOKEN_MESSENGER,
      );
      if (!burned) continue;
      const changes = t.effects.balanceChanges.nodes.filter((b) => b.coinType.repr === SUI_USDC);
      const paid = changes.find((b) => b.owner?.address === fee && BigInt(b.amount) > 0n);
      if (!paid) continue;
      const spent = changes.find((b) => b.owner?.address === t.sender.address);
      found.push({
        id: `sui:${t.digest}`,
        source: "sui",
        proof: "fee-in-burn",
        tagged: true,
        sourceTx: t.digest,
        sourceTxUrl: `https://suiscan.xyz/mainnet/tx/${t.digest}`,
        at: t.effects.timestamp,
        sender: t.sender.address,
        domain: null,
        amount: spent ? usdc(-BigInt(spent.amount)) : null,
        xebraFee: usdc(BigInt(paid.amount)),
        circleFee: null,
      });
    }
    after = page.pageInfo.endCursor ?? after;
    if (!page.pageInfo.hasNextPage) break;
  }
  return { found, cursor: after };
}

/**
 * Xebra's fee payments on one EVM chain: USDC `Transfer` logs into the fee address, each checked
 * for Xebra's ERC-8021 tag. With no cursor, starts at the latest block: there is no history to
 * read before the fee existed.
 */
export async function evmFeeTransfers(chain, feeAddress, fromBlock, isXebraTagged) {
  const latest = BigInt(await rpc(chain.rpcUrl, "eth_blockNumber", []));
  let a = fromBlock ?? latest;
  let span = 2_000n;
  const to = `0x${feeAddress.slice(2).toLowerCase().padStart(64, "0")}`;
  const found = [];
  while (a <= latest) {
    const b = a + span - 1n < latest ? a + span - 1n : latest;
    let logs;
    try {
      logs = await rpc(chain.rpcUrl, "eth_getLogs", [
        {
          address: chain.usdcAddress,
          topics: [TRANSFER_TOPIC, null, to],
          fromBlock: `0x${a.toString(16)}`,
          toBlock: `0x${b.toString(16)}`,
        },
      ]);
    } catch (e) {
      // Public RPCs cap the range differently; narrow it rather than give up.
      if (span > 100n && /range|limit|too many|exceed/i.test(String(e.message))) {
        span /= 2n;
        continue;
      }
      throw e;
    }
    for (const log of logs) {
      const tx = await rpc(chain.rpcUrl, "eth_getTransactionByHash", [log.transactionHash]);
      const block = await rpc(chain.rpcUrl, "eth_getBlockByNumber", [log.blockNumber, false]);
      found.push({
        id: `${chain.id}:${log.transactionHash}:${Number(BigInt(log.logIndex))}`,
        source: chain.id,
        proof: "fee-payment",
        tagged: isXebraTagged(tx?.input ?? "0x"),
        sourceTx: log.transactionHash,
        sourceTxUrl: `${chain.explorerUrl}/tx/${log.transactionHash}`,
        at: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        sender: `0x${log.topics[1].slice(-40)}`,
        domain: null,
        amount: null,
        xebraFee: usdc(BigInt(log.data)),
        circleFee: null,
      });
    }
    a = b + 1n;
    await sleep(150);
  }
  return { found, cursor: latest + 1n };
}
