import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A bad recipient must be refused before anything is quoted: a real (non-dry) quote issues a
 * deposit address, and a burn into it pays out to whoever the quote names.
 */

const quote = vi.fn();
const TOKENS = [
  { assetId: "nep141:xrp.omft.near", blockchain: "xrp", symbol: "XRP", decimals: 6 },
  { assetId: "nep141:doge.omft.near", blockchain: "doge", symbol: "DOGE", decimals: 8 },
  { assetId: "nep141:abs.omdep.near", blockchain: "abs", symbol: "ETH", decimals: 18 },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    blockchain: "base",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
];

vi.mock("./oneclick", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oneclick")>();
  return { ...actual, tokens: async () => TOKENS, quote: (...a: unknown[]) => quote(...a) };
});

const { compare, prepare, PlanInputError, explainQuoteError } = await import("./plan");
const { OneClickError } = await import("./oneclick");

const base = {
  from: "arc",
  amount: "25",
  sender: "0x1111111111111111111111111111111111111111",
};

beforeEach(() => quote.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("compare and prepare refuse a bad recipient before quoting", () => {
  it("says what an XRP address looks like", async () => {
    for (const fn of [compare, prepare]) {
      const p = fn({ ...base, destinationAsset: "nep141:xrp.omft.near", recipient: "0xabc" });
      await expect(p).rejects.toBeInstanceOf(PlanInputError);
      await expect(p).rejects.toThrow("That isn't an XRP address. XRP addresses start with r.");
    }
    expect(quote).not.toHaveBeenCalled();
  });

  it("catches the Dogecoin checksum 1Click does not", async () => {
    const p = prepare({
      ...base,
      destinationAsset: "nep141:doge.omft.near",
      recipient: "D8zRoR997uMex6ggsjY68zdm3RbRGkk93a",
    });
    await expect(p).rejects.toThrow(/isn't a Dogecoin address/);
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses an asset on a chain Xebra has no recipient rule for", async () => {
    const p = compare({
      ...base,
      destinationAsset: "nep141:abs.omdep.near",
      recipient: base.sender,
    });
    await expect(p).rejects.toThrow(/doesn't send to that chain/);
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses an XRP account that needs a destination tag, read from the ledger", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        return Response.json(
          body.method === "server_state"
            ? { result: { state: { validated_ledger: { reserve_base: 1_000_000 } } } }
            : { result: { account_data: { Flags: 131072 }, status: "success" } },
        );
      }),
    );
    const p = prepare({
      ...base,
      destinationAsset: "nep141:xrp.omft.near",
      recipient: "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh",
    });
    await expect(p).rejects.toThrow(/needs a destination tag/);
    expect(quote).not.toHaveBeenCalled();
  });

  it("puts an empty amount in plain words instead of a server error", async () => {
    const p = compare({ ...base, amount: "lots", destinationAsset: "x", recipient: "y" });
    await expect(p).rejects.toBeInstanceOf(PlanInputError);
    await expect(p).rejects.toThrow("Enter an amount of USDC, e.g. 25.");
  });
});

describe("explainQuoteError", () => {
  it("turns 1Click's 'recipient is not valid' into the chain's own sentence", () => {
    const e = new OneClickError("recipient is not valid", 400);
    expect(explainQuoteError(e, "aleo", 6)).toMatch(/That isn't an Aleo address/);
  });

  it("states a bridge minimum in USDC, not in base units", () => {
    const e = new OneClickError("Amount is too low for bridge, try at least 4981100", 400);
    expect(explainQuoteError(e, "btc", 6)).toBe(
      "NEAR Intents needs at least 4.9811 USDC for this destination. Send more.",
    );
  });

  it("keeps any other message as it was", () => {
    expect(explainQuoteError(new OneClickError("No liquidity available", 400), "xrp", 6)).toBe(
      "No liquidity available",
    );
    expect(explainQuoteError(new Error("boom"), "xrp", 6)).toBe("boom");
  });
});
