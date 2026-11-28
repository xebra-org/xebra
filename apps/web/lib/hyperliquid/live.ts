import { HYPERCORE } from "@xebra/sdk/core";
import type { HyperliquidDeps } from "../api/deps";
import { createTtlCache } from "../server/ttl-cache";
import { createHyperliquidReads, parseHyperliquidConfig } from "./reads";

/**
 * Hyperliquid as a source, wired to the live services, or undefined while the switch is off.
 * Read on the server only: the fee address is not a secret, but it is the server's to set.
 *
 * Caching: Circle's fee is the same for everyone and changes by an owner transaction, so it is held
 * for five minutes per destination. A burn, once found, never changes. Balances are never cached:
 * a quote must not price a balance that has already moved.
 */
const feeCache = createTtlCache<bigint | "paused" | null>(5 * 60_000);
const burnCache = createTtlCache<{ txHash: string } | "not_found" | null>(4_000);
const found = new Map<string, { txHash: string }>();

export function liveHyperliquid(): HyperliquidDeps | undefined {
  let config: ReturnType<typeof parseHyperliquidConfig>;
  try {
    config = parseHyperliquidConfig(process.env);
  } catch (err) {
    // A typo in a Hyperliquid setting turns Hyperliquid off, loudly, not the whole API.
    console.error("Hyperliquid is off: its settings are malformed", err);
    return undefined;
  }
  if (!config.enabled) return undefined;
  const reads = createHyperliquidReads({
    fetch: (input, init) => fetch(input, init),
    rpcUrl: config.rpcUrl,
    infoUrl: HYPERCORE.infoUrl,
    now: Date.now,
  });
  return {
    feeAddress: config.feeAddress,
    maxUnits: config.maxUnits,
    async forwardFee(domain) {
      try {
        return await feeCache(String(domain), async () => {
          const fee = await reads.forwardFee(domain);
          // Thrown, not returned, so an unreadable answer is not kept: the next quote asks again.
          if (fee === null) throw new Error("unreadable");
          return fee;
        });
      } catch {
        return null;
      }
    },
    account: (user) => reads.account(user),
    activationFeeTo: (address, from) => reads.activationFeeTo(address, from),
    async findBurn(user, nonce) {
      const key = `${user.toLowerCase()}:${nonce}`;
      const known = found.get(key);
      if (known) return known;
      // Several polls of the same withdrawal within a few seconds share one search.
      const answer = await burnCache(key, () => reads.findBurn(user, nonce));
      if (answer && answer !== "not_found") {
        if (found.size >= 2000) {
          const oldest = found.keys().next().value;
          if (oldest !== undefined) found.delete(oldest);
        }
        found.set(key, answer);
      }
      return answer;
    },
  };
}
