import { beforeEach, describe, expect, it, vi } from "vitest";

const planClaim = vi.fn();
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  planClaim: (...a: unknown[]) => planClaim(...a),
  stellarInboundSources: () => [8, 5, 6],
}));

const { POST } = await import("./route");
const TX = `0x${"ab".repeat(32)}`;
const PAYER = "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV";
const post = async (src: string, body: unknown) => {
  const res = await POST(
    new Request(`http://x/api/stellar-inbound/claim?src=${src}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("POST /api/stellar-inbound/claim", () => {
  beforeEach(() => planClaim.mockReset());

  it("builds the mint for the burn's own source, paid by the payer", async () => {
    planClaim.mockResolvedValue({ ok: true, xdr: "AAAA", recipient: PAYER });
    expect(await post("6", { tx: TX, payer: PAYER })).toEqual({
      status: 200,
      body: { xdr: "AAAA", recipient: PAYER },
    });
    expect(planClaim).toHaveBeenCalledWith(TX, PAYER, 6);
  });

  it("refuses an unknown source, a bad hash or a missing payer", async () => {
    expect((await post("99", { tx: TX, payer: PAYER })).status).toBe(400);
    expect((await post("6", { tx: "0x1", payer: PAYER })).status).toBe(400);
    expect((await post("6", { tx: TX })).status).toBe(400);
    expect(planClaim).not.toHaveBeenCalled();
  });

  it("says when it is already delivered", async () => {
    planClaim.mockResolvedValue({ ok: false, reason: "already minted", delivered: true });
    expect((await post("6", { tx: TX, payer: PAYER })).status).toBe(409);
  });
});
