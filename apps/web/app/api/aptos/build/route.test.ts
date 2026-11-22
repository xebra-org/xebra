import { APTOS_CCTP } from "@xebra/sdk/build";
import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.fn();
vi.mock("../../../../lib/aptos/build", () => ({
  buildAptosTransfer: (...a: unknown[]) => build(...a),
}));
vi.mock("../../../../lib/aptos/live", () => ({ liveAptosBuildDeps: () => ({}) }));

const { POST } = await import("./route");

const FEE_ADDRESS = `0x${"fa".repeat(32)}`;
const post = async (body: unknown) => {
  const res = await POST(
    new Request("http://x/api/aptos/build", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("POST /api/aptos/build: Xebra's flat fee", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("APTOS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_APTOS", FEE_ADDRESS);
    build.mockReset().mockResolvedValue({
      status: 200,
      body: { transaction: { kind: "aptos" }, maxFee: "20000", received: "4880000" },
    });
  });

  it("burns the amount less 0.01 plus 0.01% to a delivered chain, and returns the fee transaction", async () => {
    const r = await post({ sender: "0x1", amount: "5", to: "base", recipient: "0x2" });
    expect(r.status).toBe(200);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "4.9895", to: "base" }),
      {},
    );
    expect(r.body.xebraFee).toBe("10500");
    expect(r.body.feeTransaction).toMatchObject({
      kind: "aptos_call",
      function: "0x1::primary_fungible_store::transfer",
      functionArguments: [APTOS_CCTP.usdc, FEE_ADDRESS, "10500"],
    });
  });

  it("charges the same into Stellar too (Xebra's relayer delivers it)", async () => {
    await post({ sender: "0x1", amount: "2", to: "stellar", recipient: "G" });
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ amount: "1.9898" }), {});
  });

  it("passes a build refusal on without a fee transaction", async () => {
    build.mockResolvedValue({ status: 422, body: { error: "holds 1 USDC" } });
    const r = await post({ sender: "0x1", amount: "5", to: "base", recipient: "0x2" });
    expect(r).toEqual({ status: 422, body: { error: "holds 1 USDC" } });
  });

  it("refuses an amount the fee would swallow, and builds nothing without a fee address", async () => {
    expect((await post({ sender: "0x1", amount: "0.01", to: "base" })).status).toBe(422);
    vi.stubEnv("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_APTOS", "");
    expect((await post({ sender: "0x1", amount: "5", to: "base" })).status).toBe(503);
    expect(build).not.toHaveBeenCalled();
  });
});
