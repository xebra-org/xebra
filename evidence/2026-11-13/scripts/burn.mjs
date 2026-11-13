// Measure what a CCTP V2 mint (receiveMessage) actually costs on each EVM destination right now:
// current eth_gasPrice plus realised cost of recent receiveMessage txs sent straight to MessageTransmitterV2.
import { writeFileSync } from "node:fs";
const RAW = new URL("../raw", import.meta.url).pathname;
const MT = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"; // TokenMessengerV2
const SEL = "0x8e0250ee"; // depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
const CHAINS = {
  base: "https://base-rpc.publicnode.com",
  arb: "https://arb1.arbitrum.io/rpc",
  eth: "https://ethereum-rpc.publicnode.com",
  avax: "https://avalanche-c-chain-rpc.publicnode.com",
  pol: "https://polygon-bor-rpc.publicnode.com",
};
const BLOCKS = { base: 6000, arb: 40000, eth: 2000, avax: 4000, pol: 6000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 1;
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const hex = (n) => "0x" + n.toString(16);
for (const [name, url] of Object.entries(CHAINS).filter(([n]) => !process.env.ONLY || process.env.ONLY.split(",").includes(n))) {
  const out = { meta: { rpc: url, fetchedAtUtc: new Date().toISOString(), method: "eth_gasPrice + eth_getLogs(TokenMessengerV2 depositForBurn) + receipts", tokenMessengerV2: MT }, gasPriceWei: null, samples: [], errors: [] };
  try {
    out.gasPriceWei = BigInt(await rpc(url, "eth_gasPrice", [])).toString();
    const head = BigInt(await rpc(url, "eth_blockNumber", []));
    out.headBlock = head.toString();
    let logs = [];
    const span = BigInt(BLOCKS[name]);
    const step = name === "eth" ? 400n : name === "avax" ? 100n : 1000n;
    for (let from = head - span; from < head && logs.length < 400; from += step) {
      try { logs = logs.concat(await rpc(url, "eth_getLogs", [{ address: MT, fromBlock: hex(from), toBlock: hex(from + step - 1n > head ? head : from + step - 1n) }])); }
      catch (e) { out.errors.push(String(e).slice(0, 200)); }
      await sleep(250);
    }
    out.logsScanned = logs.length;
    const txs = [...new Set(logs.map((l) => l.transactionHash))].slice(-60);
    for (const h of txs) {
      if (out.samples.length >= 15) break;
      const tx = await rpc(url, "eth_getTransactionByHash", [h]);
      await sleep(150);
      if (!tx || tx.to?.toLowerCase() !== MT || !tx.input.startsWith(SEL)) continue;
      const rc = await rpc(url, "eth_getTransactionReceipt", [h]);
      await sleep(150);
      if (rc.status !== "0x1") continue;
      const l2 = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
      const l1 = rc.l1Fee ? BigInt(rc.l1Fee) : 0n;
      out.samples.push({ tx: h, block: BigInt(rc.blockNumber).toString(), gasUsed: BigInt(rc.gasUsed).toString(), effectiveGasPriceWei: BigInt(rc.effectiveGasPrice).toString(), l1FeeWei: l1.toString(), totalCostWei: (l2 + l1).toString() });
    }
  } catch (e) { out.errors.push(String(e).slice(0, 300)); }
  writeFileSync(`${RAW}/gas_burn_${name}.json`, JSON.stringify(out, null, 2));
  const costs = out.samples.map((s) => Number(s.totalCostWei)).sort((a, b) => a - b);
  const gas = out.samples.map((s) => Number(s.gasUsed)).sort((a, b) => a - b);
  console.log(name, "gasPrice gwei", Number(out.gasPriceWei) / 1e9, "samples", out.samples.length, "median gasUsed", gas[gas.length >> 1], "median cost native", costs[costs.length >> 1] / 1e18, out.errors.slice(0, 2));
}
