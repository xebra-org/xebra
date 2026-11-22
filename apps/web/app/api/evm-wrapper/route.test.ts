import { EVM_CHAINS } from "@xebra/network-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readContract } = vi.hoisted(() => ({
  readContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract })),
  };
});

const { GET } = await import("./route");

const ARC_SRC = EVM_CHAINS.arc.cctpDomainId;

describe("GET /api/evm-wrapper", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readContract.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the full viem error and returns only a plain generic error message", async () => {
    const viemDetails = [
      "HTTP request failed.",
      "URL: https://rpc.secret-node.example/v1/abc",
      'Request body: {"method":"eth_call","params":[...]}',
      "Version: viem@2.21.0",
    ].join("\n");
    readContract.mockRejectedValue(new Error(viemDetails));

    const res = await GET(new Request(`http://localhost/api/evm-wrapper?src=${ARC_SRC}`));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toEqual({ error: "could not read the wrapper" });
    expect(JSON.stringify(json)).not.toContain("rpc.secret-node.example");
    expect(JSON.stringify(json)).not.toContain("viem@2.21.0");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("rpc.secret-node.example");
  });

  it("returns 404 for a chain with no Xebra wrapper", async () => {
    const res = await GET(new Request("http://localhost/api/evm-wrapper?src=6"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no Xebra wrapper on that chain" });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("returns 200 with serialized wrapper settings when contract reads succeed", async () => {
    const arc = EVM_CHAINS.arc;
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "usdc":
          return arc.usdcAddress;
        case "tokenMessenger":
          return arc.tokenMessengerAddress;
        case "localDomain":
          return arc.cctpDomainId;
        case "paused":
          return false;
        case "getParams":
          return {
            feeBps: 5,
            minFee: 100_000n,
            minTransfer: 1_000_000n,
            maxTransfer: 50_000_000_000n,
            maxFastFeeBps: 10,
          };
        case "getDomains":
          return [
            {
              domain: 6,
              evmStyle: true,
              maxForwardFee: 500_000n,
              accountCreation: false,
              maxForwardFeeNewAccount: 0n,
            },
          ];
        default:
          throw new Error(`unexpected call ${functionName}`);
      }
    });

    const res = await GET(new Request(`http://localhost/api/evm-wrapper?src=${ARC_SRC}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      address: "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3",
      paused: false,
      params: {
        feeBps: 5,
        minFee: "100000",
        minTransfer: "1000000",
        maxTransfer: "50000000000",
        maxFastFeeBps: 10,
      },
      domains: [
        {
          domain: 6,
          evmStyle: true,
          maxForwardFee: "500000",
          accountCreation: false,
          maxForwardFeeNewAccount: "0",
        },
      ],
    });
    expect(errSpy).not.toHaveBeenCalled();
  });
});
