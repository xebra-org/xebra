import { Account, rpc } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({
  env: {
    sorobanRpcUrl: "https://soroban-rpc.example.com",
    stellarNetworkPassphrase: "Public Global Stellar Network ; September 2015",
    usdcSacAddress: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
}));

const { recipientStatus } = await import("./stellar-side");

const RECIPIENT = "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV";

describe("recipientStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exists:false when stellar-sdk throws Account not found (404)", async () => {
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValueOnce({
      code: 404,
      message: `Account not found: ${RECIPIENT}`,
    });

    const status = await recipientStatus(RECIPIENT);
    expect(status).toEqual({
      exists: false,
      hasTrustline: false,
      balance: 0n,
    });
  });

  it("returns exists:false when Error message contains 'account not found'", async () => {
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValueOnce(
      new Error(`Account not found: ${RECIPIENT}`),
    );

    const status = await recipientStatus(RECIPIENT);
    expect(status).toEqual({
      exists: false,
      hasTrustline: false,
      balance: 0n,
    });
  });

  it("rethrows when Soroban RPC fails with a network or 5xx error", async () => {
    const networkError = new Error("fetch failed: socket hang up");
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValueOnce(networkError);

    await expect(recipientStatus(RECIPIENT)).rejects.toThrow("fetch failed: socket hang up");

    const rpc500 = { code: 500, message: "Internal server error" };
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValueOnce(rpc500);

    await expect(recipientStatus(RECIPIENT)).rejects.toMatchObject({ code: 500 });
  });

  it("returns exists:true and hasTrustline:false when simulation indicates missing trustline", async () => {
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValueOnce(
      new Account(RECIPIENT, "100"),
    );
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValueOnce({
      error: "Error(Contract, #1): trustline entry is missing for account",
    } as unknown as rpc.Api.SimulateTransactionResponse);

    const status = await recipientStatus(RECIPIENT);
    expect(status).toEqual({
      exists: true,
      hasTrustline: false,
      balance: 0n,
    });
  });
});
