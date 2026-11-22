import { describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_NETWORK = "mainnet";

import type { Delivery } from "../../app/sui/sui-client";
import { nextStellarDelivery } from "./solana-bridge-form";

// Stub client components/hooks if needed for vitest environment
vi.mock("../wallet/wallet-provider", () => ({
  useWallets: () => ({ connections: {} }),
}));
vi.mock("../../lib/sui-stellar/claim-client", () => ({
  claimOnStellar: vi.fn(),
}));

describe("nextStellarDelivery", () => {
  it("keeps terminal state if already done", () => {
    const current: Delivery = { kind: "done", hash: "0xabc" };
    expect(nextStellarDelivery(current, { status: "failed" })).toEqual(current);
  });

  it("keeps terminal state if already stuck", () => {
    const current: Delivery = { kind: "stuck", message: "Error" };
    expect(nextStellarDelivery(current, { status: "delivered" })).toEqual(current);
  });

  it("transitions to done when relayer status is delivered", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextStellarDelivery(current, { status: "delivered", hash: "0x123" })).toEqual({
      kind: "done",
      hash: "0x123",
    });
    expect(nextStellarDelivery(current, { status: "delivered" })).toEqual({
      kind: "done",
      hash: null,
    });
  });

  it("transitions to done when relayer status is submitted with a hash", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextStellarDelivery(current, { status: "submitted", hash: "0xhash" })).toEqual({
      kind: "done",
      hash: "0xhash",
    });
  });

  it("transitions to stuck with reason when refused or failed", () => {
    const current: Delivery = { kind: "completing" };
    expect(
      nextStellarDelivery(current, { status: "refused", reason: "Circle signature invalid" }),
    ).toEqual({
      kind: "stuck",
      message: "Circle signature invalid",
    });
    expect(nextStellarDelivery(current, { status: "failed" })).toEqual({
      kind: "stuck",
      message: "The mint could not be completed.",
    });
  });

  it("returns idle on missing or unrecognized answer to allow retry", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextStellarDelivery(current, null)).toEqual({ kind: "idle" });
    expect(nextStellarDelivery(current, undefined)).toEqual({ kind: "idle" });
    expect(nextStellarDelivery(current, { status: "pending" })).toEqual({ kind: "idle" });
    expect(nextStellarDelivery(current, { status: "submitted" })).toEqual({ kind: "idle" });
  });
});
