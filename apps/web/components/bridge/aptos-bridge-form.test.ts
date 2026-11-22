import { describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_NETWORK = "mainnet";

import type { Delivery } from "../../app/sui/sui-client";
import { nextDelivery } from "./aptos-bridge-form";

// Stub client components/hooks if needed for vitest environment
vi.mock("../wallet/wallet-provider", () => ({
  useWallets: () => ({ connections: {} }),
}));
vi.mock("../../lib/sui-stellar/claim-client", () => ({
  claimOnStellar: vi.fn(),
}));

describe("nextDelivery", () => {
  it("keeps terminal state if already done", () => {
    const current: Delivery = { kind: "done", hash: "0xabc" };
    expect(nextDelivery(current, { status: "failed" })).toEqual(current);
  });

  it("keeps terminal state if already stuck", () => {
    const current: Delivery = { kind: "stuck", message: "Error" };
    expect(nextDelivery(current, { status: "delivered" })).toEqual(current);
  });

  it("transitions to done when relayer status is delivered", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextDelivery(current, { status: "delivered", hash: "0x123" })).toEqual({
      kind: "done",
      hash: "0x123",
    });
    expect(nextDelivery(current, { status: "delivered" })).toEqual({
      kind: "done",
      hash: null,
    });
  });

  it("transitions to done when relayer status is submitted with a hash", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextDelivery(current, { status: "submitted", hash: "0xhash" })).toEqual({
      kind: "done",
      hash: "0xhash",
    });
  });

  it("transitions to stuck with reason when refused or failed", () => {
    const current: Delivery = { kind: "completing" };
    expect(
      nextDelivery(current, { status: "refused", reason: "Circle signature invalid" }),
    ).toEqual({
      kind: "stuck",
      message: "Circle signature invalid",
    });
    expect(nextDelivery(current, { status: "failed" })).toEqual({
      kind: "stuck",
      message: "The mint could not be completed.",
    });
  });

  it("returns idle on missing or unrecognized answer to allow retry", () => {
    const current: Delivery = { kind: "completing" };
    expect(nextDelivery(current, null)).toEqual({ kind: "idle" });
    expect(nextDelivery(current, undefined)).toEqual({ kind: "idle" });
    expect(nextDelivery(current, { status: "pending" })).toEqual({ kind: "idle" });
    expect(nextDelivery(current, { status: "submitted" })).toEqual({ kind: "idle" });
  });
});
