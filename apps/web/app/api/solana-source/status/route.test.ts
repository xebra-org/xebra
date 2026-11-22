import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAttestation = vi.fn();
const mintState = vi.fn();
const verifyMessage = vi.fn();
vi.mock("../../../../lib/env", () => ({
  env: { cctpTokenMessengerId: "CTOKENMESSENGER" },
}));
vi.mock("../../../../lib/sui-stellar/attestation", () => ({
  readAttestation: (...a: unknown[]) => readAttestation(...a),
}));
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  mintState: (...a: unknown[]) => mintState(...a),
}));
vi.mock("@xebra/sdk/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xebra/sdk/core")>()),
  verifyMessage: (...a: unknown[]) => verifyMessage(...a),
}));

const { GET } = await import("./route");

const TX = "5".repeat(88);
const REQUEST_ID = "iad1::k8s2x-1700000000000-abcdef";
const G = "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV";

const ask = async (tx = TX) => {
  const res = await GET(
    new Request(`https://xebra.exchange/api/solana-source/status?tx=${tx}`, {
      headers: { "x-vercel-id": REQUEST_ID },
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

let logged: ReturnType<typeof vi.spyOn>;
/** Each line `logFailure` wrote, parsed. */
const lines = () => logged.mock.calls.map(([line]) => JSON.parse(String(line)));

describe("GET /api/solana-source/status", () => {
  beforeEach(() => {
    readAttestation
      .mockReset()
      .mockResolvedValue({ state: "complete", message: "0xab", attestation: "0xcd" });
    verifyMessage.mockReset().mockReturnValue({ recipient: G, amount: 5_000_000n });
    mintState.mockReset();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says delivered, with the mint field, once the mint has happened", async () => {
    mintState.mockResolvedValue("delivered");
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toEqual({
      state: "complete",
      mint: "delivered",
      delivered: true,
      recipient: G,
      amount: "5",
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it("says open, not delivered, while the mint is still to be made", async () => {
    mintState.mockResolvedValue("open");
    const { body } = await ask();
    expect(body).toMatchObject({ state: "complete", mint: "open", delivered: false });
    expect(logged).not.toHaveBeenCalled();
  });

  it("says unknown, not 'open', when Stellar could not be read, and logs it", async () => {
    mintState.mockResolvedValue("unknown");
    const { status, body } = await ask();
    expect(status).toBe(200);
    // `delivered` stays false for old readers; `mint` tells newer ones the check did not happen.
    expect(body).toMatchObject({ state: "complete", mint: "unknown", delivered: false });
    expect(lines()).toEqual([
      {
        route: "/api/solana-source/status",
        request_id: REQUEST_ID,
        message: "Unable to determine Stellar mint state",
        name: "Error",
        cause: null,
        tx: TX,
      },
    ]);
  });

  it("logs a failed Circle lookup instead of swallowing it, with the same 502", async () => {
    readAttestation.mockRejectedValue(new TypeError("fetch failed"));
    const { status, body } = await ask();
    expect(status).toBe(502);
    expect(body).toEqual({ state: "unknown", reason: "Circle did not answer" });
    expect(lines()).toMatchObject([
      {
        route: "/api/solana-source/status",
        request_id: REQUEST_ID,
        name: "TypeError",
        message: "fetch failed",
        tx: TX,
      },
    ]);
    expect(mintState).not.toHaveBeenCalled();
  });

  it("answers a refused message without a mint field, and pending as before", async () => {
    verifyMessage.mockImplementation(() => {
      throw new Error("not a transfer into Stellar");
    });
    expect((await ask()).body).toEqual({
      state: "complete",
      delivered: false,
      refusal: "not a transfer into Stellar",
    });
    readAttestation.mockResolvedValue({ state: "pending" });
    expect((await ask()).body).toEqual({ state: "pending" });
    expect(mintState).not.toHaveBeenCalled();
  });

  it("refuses what is not a Solana signature without asking anyone", async () => {
    const { status } = await ask("0xabc");
    expect(status).toBe(400);
    expect(readAttestation).not.toHaveBeenCalled();
  });
});
