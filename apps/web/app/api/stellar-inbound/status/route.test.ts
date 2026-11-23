import { beforeEach, describe, expect, it, vi } from "vitest";

const readAttestation = vi.fn();
vi.mock("../../../../lib/env", () => ({ env: { cctpTokenMessengerId: "C" } }));
vi.mock("../../../../lib/sui-stellar/attestation", () => ({
  readAttestation: (...a: unknown[]) => readAttestation(...a),
}));
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  mintState: async () => "open",
  stellarInboundSources: () => [8, 5, 6, 3],
}));

const { GET } = await import("./route");
const TX = `0x${"ab".repeat(32)}`;
const get = async (q: string) => {
  const res = await GET(new Request(`http://x/api/stellar-inbound/status?${q}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("GET /api/stellar-inbound/status", () => {
  beforeEach(() => readAttestation.mockReset());

  it("refuses a bad hash, or a source the relayer does not complete", async () => {
    expect((await get("tx=0x12&src=6")).status).toBe(400);
    expect((await get(`tx=${TX}&src=99`)).status).toBe(400);
    expect((await get(`tx=${TX}`)).status).toBe(400);
    expect(readAttestation).not.toHaveBeenCalled();
  });

  it("asks Circle for that source's attestation", async () => {
    readAttestation.mockResolvedValue({ state: "pending" });
    expect(await get(`tx=${TX.toUpperCase().replace("0X", "0x")}&src=6`)).toEqual({
      status: 200,
      body: { state: "pending" },
    });
    expect(readAttestation).toHaveBeenCalledWith(TX, 6);
  });
});
