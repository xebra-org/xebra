/**
 * Read-only readers of Xebra's transfers, straight from each chain's public endpoints. No keys.
 *
 * Four kinds of proof, depending on the route:
 *   - Through a Xebra contract (Stellar, Arc): the contract's own `BridgeInitiated` event.
 *   - Without one (Solana, Sui, other EVM chains): the payment into Xebra's fee address. On Solana
 *     and Sui it is in the same transaction as Circle's burn, which this checks; on EVM chains it is
 *     its own transaction, tagged with Xebra's ERC-8021 code (`isXebraTagged`).
 *   - Into Stellar: the mint that Xebra's relayer account signed (`stellarRelayedTransfers`).
 *   - Listed: a transfer from before any of the above existed, checked against Circle's own record
 *     (`listedTransfer`), with its burn and its mint both linked.
 *
 * Every reader takes a cursor and returns `{ found, cursor }` so a run only reads what is new.
 * Used by `transfers-record.mjs`, `transfers-backfill.mjs` and `near-intents-volume.mjs`.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";

// Node gives each address 250 ms before trying the next; on a slow link that fails hosts that work.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

export const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
export const STELLAR_RPC = process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com";
/** Serves `getLedgers` for any ledger, not only the last seven days (used by the backfill). */
export const STELLAR_ARCHIVE_RPC =
  process.env.STELLAR_ARCHIVE_RPC_URL || "https://archive-rpc.lightsail.network";
export const HORIZON = process.env.HORIZON_URL || "https://horizon.stellar.org";
export const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const SUI_GRAPHQL = process.env.SUI_GRAPHQL_URL || "https://graphql.mainnet.sui.io/graphql";
export const IRIS = process.env.IRIS_URL || "https://iris-api.circle.com";

export const ARC_WRAPPER = "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3";
/** The Arc wrapper's first `BridgeInitiated` (seq 1) is in block 31094669; nothing comes earlier. */
export const ARC_FIRST_BLOCK = 31_094_000n;
const ARC_LOG_SPAN = 5_000n; // the public RPC refuses wider eth_getLogs ranges
export const STELLAR_WRAPPER = "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR";
/** The first Stellar contract (9 Sep to 14 Oct 2026), retired for v2; its events still count. */
export const STELLAR_WRAPPER_V1 = "CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ";
export const STELLAR_WRAPPERS = [STELLAR_WRAPPER, STELLAR_WRAPPER_V1];

/**
 * Xebra's own Stellar accounts that sign the mint of a transfer into Stellar (Sui, Solana, Aptos to
 * Stellar): the relayer (`SUI_STELLAR_RELAYER_SECRET`'s account) and the deployer, which completed
 * the first ones by hand. A mint one of them signed is a transfer Xebra delivered.
 */
export const STELLAR_RELAYERS = [
  "GALILA7JAKZWYAMOFUKUXUZV5HTR3PQSE2C6YUEUDHALRGU5PQZKCLAG",
  "GAV4VTN62KQCHZZMWA4EPNPQB3XCB7CJKUO7RW3SMH6I42F3RYUVXI65",
];

/** CCTP domain to the chain name the page uses. */
export const DOMAINS = {
  ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [c.cctpDomainId, c.id])),
  5: "solana",
  8: "sui",
  9: "aptos",
  27: "stellar",
};
const DOMAIN_OF = Object.fromEntries(Object.entries(DOMAINS).map(([d, name]) => [name, Number(d)]));

/** A transaction's page on its chain's explorer. */
export function txUrl(chain, tx) {
  if (chain === "stellar") return `https://stellar.expert/explorer/public/tx/${tx}`;
  if (chain === "solana") return `https://solscan.io/tx/${tx}`;
  if (chain === "sui") return `https://suiscan.xyz/mainnet/tx/${tx}`;
  if (chain === "aptos") return `https://explorer.aptoslabs.com/txn/${tx}?network=mainnet`;
  const evm = Object.values(EVM_CHAINS).find((c) => c.id === chain);
  if (!evm) throw new Error(`No explorer known for ${chain}`);
  return `${evm.explorerUrl}/tx/${tx.startsWith("0x") ? tx : `0x${tx}`}`;
}

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

/**
 * One row from a Stellar contract's `bridge_initiated` event, decoded to plain values. The first
 * contract's event has no `wrapper_take` or `forward_fee`: its whole `fee` was Xebra's.
 */
export function stellarRow(v, txHash, at) {
  const v2 = v.wrapper_take !== undefined;
  return {
    id: `stellar:${hex(v.transfer_id)}`,
    source: "stellar",
    proof: "contract",
    sourceTx: txHash,
    sourceTxUrl: txUrl("stellar", txHash),
    at: new Date(at).toISOString(),
    sender: v.user,
    // The contract's own count at this transfer (`get_seq`), so a gap in the record shows.
    contract: v2 ? STELLAR_WRAPPER : STELLAR_WRAPPER_V1,
    seq: Number(v.seq),
    domain: Number(v.destination_domain),
    mintRecipient: hex(v.mint_recipient),
    recipientOwner: v.recipient_owner ? hex(v.recipient_owner) : null,
    amount: usdc(v.amount, 7),
    xebraFee: usdc(v2 ? v.wrapper_take : (v.fee ?? 0), 7),
    circleFee: v2 ? usdc(v.forward_fee ?? 0, 7) : null,
  };
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
      filters: [{ type: "contract", contractIds: STELLAR_WRAPPERS, topics: [[topic, "**"]] }],
      pagination: { limit: 200, ...(page.cursor ? { cursor: page.cursor } : {}) },
    });
    if (cursorLedger === undefined && startedAt === null && res.oldestLedgerCloseTime) {
      startedAt = new Date(Number(res.oldestLedgerCloseTime) * 1000).toISOString();
    }
    for (const e of res.events) {
      const v = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
      found.push(stellarRow(v, e.txHash, e.ledgerClosedAt));
    }
    // The RPC scans a limited stretch of ledgers per call and hands back a cursor where it
    // stopped, events or not, so follow it to the latest ledger rather than stopping on a short page.
    const at = res.cursor ? Number(BigInt(res.cursor.split("-")[0]) >> 32n) : res.latestLedger;
    if (at >= res.latestLedger) break;
    page = { cursor: res.cursor };
  }
  return { found, cursor: health.latestLedger + 1, gap, startedAt };
}

// --- Stellar history, past the RPC's seven days ------------------------------------------------

/** A Horizon GET, waiting out its rate limit. Null for an account Horizon does not know. */
export async function horizon(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${HORIZON}${pathOrUrl}`;
  for (let attempt = 0; ; attempt++) {
    const res = await request(url);
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    // SDF's Horizon limits each address per hour; wait it out rather than lose the read.
    if (attempt >= 9) throw new Error(`Horizon ${res.status} for ${url}`);
    await sleep(10_000 * (attempt + 1));
  }
}

/** Every operation of a Stellar account, oldest first, from after `cursor` (a paging token). */
async function* horizonOperations(account, cursor) {
  let url = `/accounts/${account}/operations?order=asc&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
  for (;;) {
    const page = await horizon(url);
    const records = page?._embedded?.records ?? [];
    yield* records;
    if (records.length < 200) return;
    url = page._links.next.href;
    await sleep(300);
  }
}

/** JSON-encoded ScVal (as the RPC's `xdrFormat: "json"` returns it) to the values `scValToNative` gives. */
function fromJsonScVal(v) {
  if (v === null || typeof v !== "object") return v;
  if ("map" in v) {
    return Object.fromEntries(
      (v.map ?? []).map(({ key, val }) => [fromJsonScVal(key), fromJsonScVal(val)]),
    );
  }
  if ("vec" in v) return (v.vec ?? []).map(fromJsonScVal);
  if ("symbol" in v) return v.symbol;
  if ("string" in v) return v.string;
  if ("address" in v) return v.address;
  if ("bool" in v) return v.bool;
  if ("bytes" in v) return Buffer.from(v.bytes, "hex");
  for (const k of ["i128", "u128", "i64", "u64"]) {
    if (k in v) {
      const n = v[k];
      if (typeof n === "object" && n !== null && "hi" in n) {
        return (BigInt(n.hi) << 64n) + BigInt.asUintN(64, BigInt(n.lo));
      }
      return BigInt(n);
    }
  }
  if ("u32" in v) return v.u32;
  if ("i32" in v) return v.i32;
  if ("void" in v || v === "void") return null;
  return v;
}

/**
 * The Xebra contract rows in one Stellar transaction, read from its ledger through an archive RPC
 * (Horizon no longer serves transaction meta, and a plain RPC keeps only seven days).
 */
export async function stellarArchiveRows(txHash, ledger) {
  const res = await rpc(STELLAR_ARCHIVE_RPC, "getLedgers", {
    startLedger: Number(ledger),
    pagination: { limit: 1 },
    xdrFormat: "json",
  });
  const l = res.ledgers?.[0];
  if (!l || Number(l.sequence) !== Number(ledger)) throw new Error(`ledger ${ledger} not served`);
  const meta = Object.values(l.metadataJson)[0];
  const tx = meta.tx_processing.find((t) => t.result.transaction_hash === txHash);
  if (!tx) throw new Error(`transaction ${txHash} not in ledger ${ledger}`);
  const apply = Object.values(tx.tx_apply_processing)[0];
  const events = [
    ...(apply.operations ?? []).flatMap((op) => op.events ?? []),
    ...(apply.soroban_meta?.events ?? []),
  ];
  const at = new Date(Number(l.ledgerCloseTime) * 1000).toISOString();
  return events
    .filter(
      (e) =>
        STELLAR_WRAPPERS.includes(e.contract_id) &&
        e.body?.v0?.topics?.[0]?.symbol === "bridge_initiated",
    )
    .map((e) => stellarRow(fromJsonScVal(e.body.v0.data), txHash, at));
}

/**
 * Every transfer one Stellar account sent through a Xebra contract, over the account's whole
 * history: Horizon finds the transactions that moved USDC into a contract, the archive RPC reads
 * each one's `bridge_initiated` event. Also returns the accounts it created.
 */
export async function stellarAccountTransfers(account) {
  const txs = new Map();
  const created = [];
  for await (const op of horizonOperations(account)) {
    if (op.type === "create_account" && op.funder === account) created.push(op.account);
    if (op.type !== "invoke_host_function" || !op.transaction_successful) continue;
    const touches = (op.asset_balance_changes ?? []).some(
      (c) => c.from === account && STELLAR_WRAPPERS.includes(c.to),
    );
    if (touches) txs.set(op.transaction_hash, null);
  }
  const found = [];
  for (const hash of txs.keys()) {
    const tx = await horizon(`/transactions/${hash}`);
    found.push(...(await stellarArchiveRows(hash, tx.ledger)));
  }
  return { found, created };
}

/** A CCTP v2 message, as Stellar's `receive_message` and `mint_and_forward` take it. */
export function parseCctpMessage(bytes) {
  const b = Buffer.from(bytes);
  const body = b.subarray(148);
  const word = (buf, at) => BigInt(`0x${buf.subarray(at, at + 32).toString("hex")}`);
  return {
    sourceDomain: b.readUInt32BE(4),
    destinationDomain: b.readUInt32BE(8),
    nonce: hex(b.subarray(12, 44)),
    amount: word(body, 68),
    messageSender: hex(body.subarray(100, 132)),
    feeExecuted: body.length >= 196 ? word(body, 164) : 0n,
  };
}

/**
 * The Sui burn behind a mint: the sender's last `deposit_for_burn` of exactly `amount` at or
 * before `before`. CCTP v2 messages leave the nonce out at the source, so the sender, the amount and
 * the order in time are what join the two legs.
 */
export async function suiBurnBySender(sender, amount, before) {
  const query = `query($a: SuiAddress!, $after: String) {
    transactions(first: 50, after: $after, filter: { sentAddress: $a }) {
      pageInfo { hasNextPage endCursor }
      nodes { digest effects { status timestamp balanceChanges { nodes { owner { address } amount coinType { repr } } } }
        kind { ... on ProgrammableTransaction { commands(first: 30) { nodes {
          ... on MoveCallCommand { function { name module { package { address } } } } } } } } }
    }
  }`;
  let after = null;
  let best = null;
  for (let pages = 0; pages < 40; pages++) {
    const res = await request(SUI_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { a: sender, after } }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(`Sui GraphQL: ${body.errors[0].message}`);
    const page = body.data.transactions;
    for (const t of page.nodes) {
      if (t.effects.status !== "SUCCESS" || Date.parse(t.effects.timestamp) > Date.parse(before)) {
        continue;
      }
      const burned = (t.kind?.commands?.nodes ?? []).some(
        (c) =>
          c.function?.name === "deposit_for_burn" &&
          c.function.module?.package?.address === SUI_TOKEN_MESSENGER,
      );
      const spent = t.effects.balanceChanges.nodes.find(
        (b) => b.coinType.repr === SUI_USDC && b.owner?.address === sender,
      );
      if (burned && spent && -BigInt(spent.amount) === amount) {
        best = { digest: t.digest, at: t.effects.timestamp };
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return best;
}

/**
 * Transfers into Stellar whose mint one of Xebra's relayer accounts signed. `cursors` maps each
 * relayer to the paging token of the last operation read. A Sui source is joined to its burn; any
 * other source is shown by its Stellar mint.
 */
export async function stellarRelayedTransfers(cursors = {}) {
  const found = [];
  const next = { ...cursors };
  for (const relayer of STELLAR_RELAYERS) {
    for await (const op of horizonOperations(relayer, cursors[relayer])) {
      next[relayer] = op.paging_token;
      if (op.type !== "invoke_host_function" || !op.transaction_successful) continue;
      const [, fn, message] = op.parameters ?? [];
      if (fn?.type !== "Sym" || message?.type !== "Bytes") continue;
      const name = scValToNative(xdr.ScVal.fromXDR(fn.value, "base64"));
      if (name !== "mint_and_forward" && name !== "receive_message") continue;
      const m = parseCctpMessage(scValToNative(xdr.ScVal.fromXDR(message.value, "base64")));
      if (m.destinationDomain !== 27) continue;
      const source = DOMAINS[m.sourceDomain] ?? `domain-${m.sourceDomain}`;
      const burn =
        source === "sui" ? await suiBurnBySender(m.messageSender, m.amount, op.created_at) : null;
      found.push({
        id: burn ? `${source}:${burn.digest}` : `stellar-mint:${op.transaction_hash}`,
        source,
        proof: "relayed",
        sourceTx: burn ? burn.digest : op.transaction_hash,
        sourceTxUrl: burn ? txUrl(source, burn.digest) : txUrl("stellar", op.transaction_hash),
        deliveryTx: op.transaction_hash,
        deliveryTxUrl: txUrl("stellar", op.transaction_hash),
        at: new Date(burn ? burn.at : op.created_at).toISOString(),
        sender: m.messageSender,
        domain: 27,
        amount: usdc(m.amount),
        xebraFee: null,
        circleFee: usdc(m.feeExecuted),
      });
    }
  }
  return { found, cursor: next };
}

/** When a transaction happened, read from its own chain. */
async function sourceTime(chain, tx) {
  if (chain === "stellar") return (await horizon(`/transactions/${tx}`))?.created_at ?? null;
  if (chain === "sui") {
    const res = await request(SUI_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query($d: String!) { transaction(digest: $d) { sender { address } effects { timestamp } } }",
        variables: { d: tx },
      }),
    });
    return (await res.json()).data?.transaction?.effects?.timestamp ?? null;
  }
  if (chain === "solana") {
    const t = await rpc(SOLANA_RPC, "getTransaction", [
      tx,
      { maxSupportedTransactionVersion: 0, commitment: "finalized" },
    ]);
    return t?.blockTime ? new Date(t.blockTime * 1000).toISOString() : null;
  }
  const evm = Object.values(EVM_CHAINS).find((c) => c.id === chain);
  if (!evm) return null;
  const receipt = await rpc(evm.rpcUrl, "eth_getTransactionReceipt", [tx]);
  if (!receipt) return null;
  const block = await rpc(evm.rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  return new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
}

/**
 * A transfer from before Xebra's contracts, fees and relayer, given by its burn transaction and
 * checked against Circle's own record: Circle must have the burn and have signed it. The mint is the
 * one Circle names, or `mint` when Circle's record of an early burn names none. Throws when the
 * check fails, so nothing unchecked is written.
 */
export async function listedTransfer({ chain, tx, mint: knownMint, note }) {
  const domain = DOMAIN_OF[chain];
  if (domain === undefined) throw new Error(`No CCTP domain for ${chain}`);
  const res = await request(`${IRIS}/v2/messages/${domain}?transactionHash=${tx}`);
  if (!res.ok) throw new Error(`Circle has no message for ${chain} ${tx} (${res.status})`);
  const message = (await res.json()).messages?.[0];
  if (message?.status !== "complete") throw new Error(`${chain} ${tx} is not complete at Circle`);
  const d = message.decodedMessage;
  const to = DOMAINS[Number(d.destinationDomain)] ?? null;
  const mint = message.forwardTxHash ?? message.destinationMintTxHash ?? knownMint ?? null;
  const at = await sourceTime(chain, tx);
  if (!at) throw new Error(`${chain} ${tx} not found on its chain`);
  return {
    id: `${chain}:${tx}`,
    source: chain,
    proof: "listed",
    sourceTx: tx,
    sourceTxUrl: txUrl(chain, tx),
    ...(mint && to ? { deliveryTx: mint, deliveryTxUrl: txUrl(to, mint) } : {}),
    at: new Date(at).toISOString(),
    sender: d.decodedMessageBody?.messageSender ?? null,
    domain: Number(d.destinationDomain),
    amount: usdc(BigInt(d.decodedMessageBody.amount)),
    xebraFee: null,
    circleFee: d.decodedMessageBody.feeExecuted
      ? usdc(BigInt(d.decodedMessageBody.feeExecuted))
      : null,
    ...(note ? { note } : {}),
  };
}

/**
 * How many transfers each Xebra contract has counted (`get_seq` on Stellar, `seq()` on Arc): the
 * check that the record is not missing any.
 */
export async function contractCounts() {
  const {
    Account,
    Contract,
    TransactionBuilder,
    rpc: StellarRpc,
  } = await import("@stellar/stellar-sdk");
  const server = new StellarRpc.Server(STELLAR_RPC);
  const counts = {};
  for (const id of STELLAR_WRAPPERS) {
    // Simulation only: the source account is never charged and need not sign.
    const tx = new TransactionBuilder(new Account(STELLAR_RELAYERS[0], "0"), {
      fee: "100",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    })
      .addOperation(new Contract(id).call("get_seq"))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!sim.result) throw new Error(`get_seq on ${id}: ${sim.error ?? "no result"}`);
    counts[`stellar:${id}`] = Number(scValToNative(sim.result.retval));
  }
  const seq = await rpc(ARC_RPC, "eth_call", [{ to: ARC_WRAPPER, data: "0x6857ab40" }, "latest"]);
  counts[`arc:${ARC_WRAPPER}`] = Number(BigInt(seq));
  return counts;
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

export const APTOS_INDEXER =
  process.env.APTOS_INDEXER_URL || "https://api.mainnet.aptoslabs.com/v1/graphql";
export const APTOS_NODE = process.env.APTOS_NODE_URL || "https://api.mainnet.aptoslabs.com/v1";
const APTOS_USDC = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";

/**
 * Xebra's fee payments on Aptos: USDC deposits into the fee address, read from Aptos's public
 * indexer. The fee is its own transaction there, as on EVM chains. `afterVersion` is the last
 * transaction version already recorded.
 */
export async function aptosFeeTransfers(feeAddress, afterVersion) {
  const query = `query($a: String!, $usdc: String!, $v: bigint!) {
    fungible_asset_activities(
      where: { owner_address: { _eq: $a }, asset_type: { _eq: $usdc }, type: { _eq: "0x1::fungible_asset::Deposit" }, transaction_version: { _gt: $v } }
      order_by: { transaction_version: asc }, limit: 100
    ) { transaction_version amount transaction_timestamp is_transaction_success }
  }`;
  let v = afterVersion ?? "0";
  const found = [];
  for (;;) {
    const res = await request(APTOS_INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { a: feeAddress.toLowerCase(), usdc: APTOS_USDC, v },
      }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(`Aptos indexer: ${body.errors[0].message}`);
    const page = body.data.fungible_asset_activities;
    for (const d of page) {
      v = String(d.transaction_version);
      if (!d.is_transaction_success) continue;
      const tx = await (await request(`${APTOS_NODE}/transactions/by_version/${v}`)).json();
      found.push({
        id: `aptos:${tx.hash}`,
        source: "aptos",
        proof: "fee-payment",
        tagged: false,
        sourceTx: tx.hash,
        sourceTxUrl: txUrl("aptos", tx.hash),
        at: new Date(`${d.transaction_timestamp}Z`).toISOString(),
        sender: tx.sender ?? null,
        domain: null,
        amount: null,
        xebraFee: usdc(BigInt(d.amount)),
        circleFee: null,
      });
    }
    if (page.length < 100) break;
  }
  return { found, cursor: v };
}

/**
 * Xebra's fee payments on one EVM chain: USDC `Transfer` logs into a fee address (one or several),
 * each checked for Xebra's ERC-8021 tag. With no cursor, starts at the latest block: on 26 Nov 2026
 * neither fee address had ever received USDC or sent a transaction on any chain (balance and nonce
 * zero), so there is no earlier history to read.
 */
export async function evmFeeTransfers(chain, feeAddresses, fromBlock, isXebraTagged) {
  const latest = BigInt(await rpc(chain.rpcUrl, "eth_blockNumber", []));
  let a = fromBlock ?? latest;
  let span = 2_000n;
  const to = [feeAddresses].flat().map((f) => `0x${f.slice(2).toLowerCase().padStart(64, "0")}`);
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
      // The Arc contract paying out its own fees to the same address is not a transfer.
      if (`0x${log.topics[1].slice(-40)}`.toLowerCase() === ARC_WRAPPER.toLowerCase()) continue;
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
