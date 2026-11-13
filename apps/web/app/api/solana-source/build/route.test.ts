import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.fn();
const price = vi.fn();
const toStellar = vi.fn();
vi.mock("../../../../lib/solana-source/server", () => ({
  buildSolanaSourceBurn: (...a: unknown[]) => build(...a),
  priceSolanaToEvm: (...a: unknown[]) => price(...a),
  checkSolanaToStellar: (...a: unknown[]) => toStellar(...a),
}));

const { POST } = await import("./route");
const { SolanaSourceError } = await import("../../../../lib/solana-source/checks");

const SENDER = "DtG5HoH4WKC6HjmdTm4k7PNreyQmB1UmpFfqHMCeNj9y";
const EVM = "0x140d18eaa68c34c3ca761988f83cf8c395526e1d";
const G = "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV";

const post = async (body: unknown) => {
  const res = await POST(
    new Request("http://x/api/solana-source/build", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("POST /api/solana-source/build", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    build.mockReset().mockResolvedValue({
      transaction: "dHg=",
      eventAccount: "E",
      lastValidBlockHeight: 7,
    });
    price.mockReset().mockResolvedValue({ ok: true, maxFee: 60_000n, received: 4_940_000n });
    toStellar.mockReset().mockResolvedValue(undefined);
  });

  it("is not there while SOLANA_SENDS_TO is unset", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", undefined as unknown as string);
    expect((await post({ sender: SENDER, amount: "5", chain: "base" })).status).toBe(404);
  });

  it("builds a forwarded burn to an EVM chain it names, at the fee it priced", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "base");
    const r = await post({
      sender: SENDER,
      amount: "5",
      recipient: EVM,
      chain: "base",
      maxFee: "60000",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ transaction: "dHg=", maxFee: "60000", received: "4940000" });
    expect(build).toHaveBeenCalledWith({
      sender: SENDER,
      amount: 5_000_000n,
      target: { kind: "evm", chain: expect.objectContaining({ id: "base" }), recipient: EVM },
      maxFee: 60_000n,
    });
  });

  it("refuses a chain the switch does not name, and Stellar unless named", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "all");
    expect(
      (await post({ sender: SENDER, amount: "5", recipient: G, chain: "stellar" })).status,
    ).toBe(400);
    vi.stubEnv("SOLANA_SENDS_TO", "base");
    const r = await post({
      sender: SENDER,
      amount: "5",
      recipient: EVM,
      chain: "arbitrum",
      maxFee: "1",
    });
    expect(r.status).toBe(400);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses to sign at a fee higher than the page showed", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "base");
    const r = await post({
      sender: SENDER,
      amount: "5",
      recipient: EVM,
      chain: "base",
      maxFee: "59999",
    });
    expect(r.status).toBe(409);
    expect(r.body.maxFee).toBe("60000");
    expect(build).not.toHaveBeenCalled();
  });

  it("builds a burn to Stellar with no fee, after checking the recipient", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "stellar");
    const r = await post({ sender: SENDER, amount: "2.5", recipient: G, chain: "stellar" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ maxFee: "0", received: "2500000" });
    expect(toStellar).toHaveBeenCalledWith(G, 2_500_000n);
    expect(price).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith({
      sender: SENDER,
      amount: 2_500_000n,
      target: { kind: "stellar", recipient: G },
      maxFee: 0n,
    });
  });

  it("passes a recipient refusal on, and builds nothing", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "stellar");
    toStellar.mockRejectedValue(new SolanaSourceError("no trustline", 422, "invalid_recipient"));
    const r = await post({ sender: SENDER, amount: "2.5", recipient: G, chain: "stellar" });
    expect(r).toEqual({ status: 422, body: { error: "no trustline" } });
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a bad sender, a bad amount, and an amount over the cap", async () => {
    vi.stubEnv("SOLANA_SENDS_TO", "base");
    vi.stubEnv("SOLANA_SOURCE_MAX_USDC", "10");
    const base = { recipient: EVM, chain: "base", maxFee: "60000" };
    expect((await post({ ...base, sender: "0xabc", amount: "5" })).status).toBe(400);
    expect((await post({ ...base, sender: SENDER, amount: "-1" })).status).toBe(400);
    expect((await post({ ...base, sender: SENDER, amount: "10.000001" })).status).toBe(422);
    expect(build).not.toHaveBeenCalled();
  });
});
