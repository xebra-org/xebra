/**
 * Completes a Sui -> Stellar CCTP V2 burn on Stellar mainnet: waits for Circle's attestation, checks
 * the recipient can receive, then calls `mint_and_forward` on the CctpForwarder.
 *
 * Env:
 *   SUI_DIGEST        the burn transaction digest printed by sui-to-stellar.mts
 *   STELLAR_RECIPIENT the G... address named in the burn (used only for the pre-spend check)
 *   STELLAR_SECRET    funded XLM account that pays the fee (read from env, never logged)
 *   MODE=simulate     stop after a successful Soroban simulation, send nothing (default: submit)
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";

const SOROBAN_RPC = process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com";
const HORIZON = "https://horizon.stellar.org";
const IRIS = "https://iris-api.circle.com/v2/";
const FORWARDER = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const SUI_DOMAIN = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface IrisMessage {
  status: string;
  message: string;
  attestation: string;
}

async function waitForAttestation(digest: string, timeoutMs = 20 * 60_000) {
  const url = `${IRIS}messages/${SUI_DOMAIN}?transactionHash=${digest}`;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const m = ((await res.json()) as { messages?: IrisMessage[] }).messages?.[0];
      const state = m
        ? `${m.status}${m.attestation && m.attestation !== "PENDING" ? "+att" : ""}`
        : "no message yet";
      if (state !== last) console.log(`iris: ${state}`);
      last = state;
      if (m?.status === "complete" && m.attestation && m.attestation !== "PENDING") return m;
    } else if (String(res.status) !== last) {
      console.log(`iris: http ${res.status}`);
      last = String(res.status);
    }
    await sleep(5000);
  }
  throw new Error("timed out waiting for Circle attestation");
}

async function recipientReady(server: rpc.Server, recipient: string) {
  let account: Awaited<ReturnType<rpc.Server["getAccount"]>>;
  try {
    account = await server.getAccount(recipient);
  } catch {
    return { exists: false, hasTrustline: false };
  }
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(USDC).call("balance", Address.fromString(recipient).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes("trustline entry is missing for account"))
      return { exists: true, hasTrustline: false };
    throw new Error(`recipient check failed: ${sim.error}`);
  }
  return { exists: true, hasTrustline: true };
}

/** stellar-sdk 13 cannot decode protocol 23+ result meta, so confirm through Horizon instead. */
async function confirmViaHorizon(hash: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${HORIZON}/transactions/${hash}`);
    if (r.ok) {
      const t = (await r.json()) as { successful: boolean; ledger: number; fee_charged: string };
      return t;
    }
    await sleep(3000);
  }
  throw new Error(
    `no confirmation for ${hash} within ${timeoutMs}ms; it may still land, check it before retrying`,
  );
}

async function main() {
  const digest = process.env.SUI_DIGEST;
  const recipient = process.env.STELLAR_RECIPIENT;
  const secret = process.env.STELLAR_SECRET;
  const simulateOnly = process.env.MODE === "simulate";
  if (!digest || !recipient || !secret)
    throw new Error("need SUI_DIGEST, STELLAR_RECIPIENT, STELLAR_SECRET");

  const kp = Keypair.fromSecret(secret);
  const server = new rpc.Server(SOROBAN_RPC);

  const ready = await recipientReady(server, recipient);
  if (!ready.exists || !ready.hasTrustline) {
    throw new Error(
      `recipient not ready (${JSON.stringify(ready)}); refusing to spend. The USDC would be stuck at the forwarder.`,
    );
  }
  console.log("recipient exists and holds a USDC trustline");

  const att = await waitForAttestation(digest);
  console.log(`attested; message ${att.message.length / 2 - 1} bytes`);

  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.PUBLIC })
    .addOperation(
      new Contract(FORWARDER).call(
        "mint_and_forward",
        nativeToScVal(Buffer.from(att.message.slice(2), "hex"), { type: "bytes" }),
        nativeToScVal(Buffer.from(att.attestation.slice(2), "hex"), { type: "bytes" }),
      ),
    )
    .setTimeout(180)
    .build();

  const prepared = await server.prepareTransaction(tx); // simulates, throws on failure
  console.log("simulation ok");
  if (simulateOnly) return;

  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  console.log(`submitted ${sent.hash} (${sent.status})`);
  if (sent.status === "ERROR") throw new Error("send rejected");
  const done = await confirmViaHorizon(sent.hash);
  console.log(
    done.successful ? "SUCCESS" : "FAILED",
    `ledger ${done.ledger} fee ${done.fee_charged} stroops`,
  );
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
