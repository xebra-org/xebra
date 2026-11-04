/**
 * Waits for a submitted Stellar transaction to be applied, asking Horizon.
 *
 * Not `rpc.Server.pollTransaction`: stellar-sdk 13 cannot decode the result metadata protocol 23
 * and later produce, so it throws `TypeError: Bad union switch: 4` on a transaction that has
 * succeeded. Seen live on Stellar testnet on 2026-11-05, where a landed `claim` was reported as a
 * failure; apps/web/lib/cctp-bridge.ts (`waitForTx`) documents the same on mainnet. Horizon
 * answers "did it land, and did it succeed" as plain JSON.
 */
export interface WaitDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForTransaction(
  horizonUrl: string,
  txHash: string,
  timeoutMs = 90_000,
  deps: WaitDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const url = `${horizonUrl.replace(/\/$/, "")}/transactions/${txHash}`;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    try {
      const res = await doFetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { successful?: boolean };
        if (body.successful === true) return;
        if (body.successful === false) {
          throw new LandedButFailedError(txHash);
        }
      } else if (res.status !== 404) {
        throw new Error(`Horizon returned ${res.status} while checking ${txHash}`);
      }
    } catch (err) {
      // A network blip must not abort a transaction that probably landed; a real on-chain
      // failure must not be swallowed.
      if (err instanceof LandedButFailedError) throw err;
    }
    await sleep(2000);
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${txHash} to apply`,
  );
}

export class LandedButFailedError extends Error {
  constructor(txHash: string) {
    super(`transaction ${txHash} was included in a ledger but failed`);
  }
}
