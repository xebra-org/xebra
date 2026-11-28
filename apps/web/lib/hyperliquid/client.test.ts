import { describe, expect, it, vi } from "vitest";
import {
  exchangeOutcome,
  readHyperliquidBalances,
  recallHyperliquidTransfer,
  rememberHyperliquidTransfer,
  statusView,
  submitSigned,
} from "./client";

const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ID = `${USER}:1795870421000`;

describe("exchangeOutcome", () => {
  it("is ok only for Hyperliquid's own ok", () => {
    expect(exchangeOutcome(200, { status: "ok", response: { type: "default" } })).toEqual({
      ok: true,
    });
  });

  it("passes Hyperliquid's refusal on, in a sentence that says the money has not moved", () => {
    const r = exchangeOutcome(200, {
      status: "err",
      response: "Insufficient balance for withdrawal",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/Insufficient balance for withdrawal/);
    expect(r.message).toMatch(/still in your Hyperliquid balance/);
  });

  it("does not claim a refusal when the answer could not be read", () => {
    for (const [status, body] of [
      [502, null],
      [200, { weird: true }],
      [429, { status: "err" }],
    ] as const) {
      const r = exchangeOutcome(status, body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refused).toBe(false);
    }
  });
});

describe("submitSigned", () => {
  it("posts the body as JSON to Hyperliquid's exchange and reads the answer", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: "ok", response: { type: "default" } }),
    );
    const body = {
      action: { type: "usdSend" },
      nonce: 1,
      signature: { r: "0x1", s: "0x2", v: 27 },
    };
    const r = await submitSigned("https://api.hyperliquid.xyz/exchange", body, fetchImpl);
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hyperliquid.xyz/exchange",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });

  it("refuses to post anywhere but Hyperliquid's exchange", async () => {
    const fetchImpl = vi.fn();
    await expect(submitSigned("https://evil.example/exchange", {}, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure as unknown, not refused: the withdrawal may have gone through", async () => {
    const r = await submitSigned(
      "https://api.hyperliquid.xyz/exchange",
      {},
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(r).toMatchObject({ ok: false, refused: false });
  });
});

describe("readHyperliquidBalances", () => {
  it("reads perps withdrawable and spot USDC less holds", async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        body.type === "clearinghouseState"
          ? { withdrawable: "100.5" }
          : { balances: [{ coin: "USDC", token: 0, total: "12.25", hold: "2" }] },
      );
    });
    expect(await readHyperliquidBalances(USER, fetchImpl)).toEqual({
      perps: 100_500_000n,
      spot: 10_250_000n,
    });
  });

  it("answers null when Hyperliquid cannot be read", async () => {
    expect(
      await readHyperliquidBalances(
        USER,
        vi.fn(async () => new Response("", { status: 500 })),
      ),
    ).toBeNull();
  });
});

describe("remembering a withdrawal", () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };

  it("keeps the id and destination, and reads back only what is well formed", () => {
    const s = store();
    expect(rememberHyperliquidTransfer({ id: ID, to: "arc", at: 5 }, s)).toBe(true);
    expect(recallHyperliquidTransfer(s)).toEqual({ id: ID, to: "arc", at: 5 });
    s.setItem("xebra.hyperliquid.transfer", JSON.stringify({ id: "nope", to: "arc" }));
    expect(recallHyperliquidTransfer(s)).toBeNull();
    s.setItem("xebra.hyperliquid.transfer", JSON.stringify({ id: ID, to: "stellar" }));
    expect(recallHyperliquidTransfer(s)).toBeNull();
    rememberHyperliquidTransfer(null, s);
    expect(recallHyperliquidTransfer(s)).toBeNull();
  });

  it("says so when the browser will not store it, instead of throwing", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(rememberHyperliquidTransfer({ id: ID, to: "arc", at: 5 }, blocked)).toBe(false);
    expect(recallHyperliquidTransfer(blocked)).toBeNull();
  });
});

describe("statusView", () => {
  const base = { chain: "hyperliquid", tx: ID, deliveryTx: null, reason: null, claimUrl: null };

  it("walks the three steps: Hyperliquid, Circle, arrival", () => {
    expect(statusView({ ...base, state: "pending", burnTx: null }).step).toBe(1);
    expect(statusView({ ...base, state: "pending", burnTx: `0x${"a".repeat(64)}` }).step).toBe(2);
    expect(statusView({ ...base, state: "delivering", burnTx: `0x${"a".repeat(64)}` }).step).toBe(
      2,
    );
    const done = statusView({ ...base, state: "delivered", burnTx: `0x${"a".repeat(64)}` });
    expect(done.step).toBe(3);
    expect(done.done).toBe(true);
  });

  it("names the way out when Circle could not deliver", () => {
    const v = statusView({
      ...base,
      state: "failed",
      burnTx: `0x${"a".repeat(64)}`,
      claimUrl: "https://xebra.exchange/claim?tx=0xaa&src=19",
    });
    expect(v.problem).toMatch(/claim/i);
    expect(v.claimUrl).toBe("https://xebra.exchange/claim?tx=0xaa&src=19");
  });

  it("passes the server's reason on while it waits", () => {
    expect(
      statusView({
        ...base,
        state: "pending",
        burnTx: null,
        reason: "still in your Hyperliquid balance",
      }).note,
    ).toMatch(/Hyperliquid balance/);
  });
});
