import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { describeRejectedTransaction } from "../cctp-bridge";
import { env } from "../env";

/**
 * Finish a Sui to Stellar transfer from the user's own Stellar wallet. The server prepares the
 * `mint_and_forward` call with the user as the source account (`/api/sui-stellar/claim`); the wallet
 * signs it; this sends it and waits for Horizon to confirm. The user pays the network fee, a few
 * hundredths of an XLM, and no relayer is involved.
 */
export async function claimOnStellar(
  kit: StellarWalletsKit,
  payer: string,
  digest: string,
  /** Another chain's claim route, and how it names the burn (Aptos: `/api/aptos/claim`, `tx`). */
  via: { url: string; key: string } = { url: "/api/sui-stellar/claim", key: "digest" },
): Promise<{ hash: string; delivered: boolean }> {
  const res = await fetch(via.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [via.key]: digest, payer }),
  });
  const body = (await res.json()) as { xdr?: string; error?: string; delivered?: boolean };
  if (body.delivered) return { hash: "", delivered: true };
  if (!res.ok || !body.xdr) throw new Error(body.error ?? "Could not prepare the mint.");

  const { signedTxXdr } = await kit.signTransaction(body.xdr, {
    networkPassphrase: env.stellarNetworkPassphrase,
    address: payer,
  });

  const server = new rpc.Server(env.sorobanRpcUrl);
  const signed = TransactionBuilder.fromXDR(signedTxXdr, env.stellarNetworkPassphrase);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("The network is busy. Nothing was sent; try again in a few seconds.");
  }
  if (sent.status === "ERROR") throw new Error(describeRejectedTransaction(sent, "mint"));

  await confirm(sent.hash);
  return { hash: sent.hash, delivered: false };
}

/** Horizon answers 404 until the transaction is in a ledger; then says whether it succeeded. */
async function confirm(hash: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${env.horizonUrl.replace(/\/$/, "")}/transactions/${hash}`;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.ok) {
        const t = (await r.json()) as { successful?: boolean };
        if (t.successful === true) return;
        if (t.successful === false) {
          throw new Error(
            `The mint was included in a ledger but failed (${hash}). Your USDC has not moved; try again.`,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("included in a ledger but failed"))
        throw err;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(
    `Still waiting on ${hash} after ${Math.round(timeoutMs / 1000)}s. Check it on stellar.expert; if it lands, the transfer is complete.`,
  );
}
