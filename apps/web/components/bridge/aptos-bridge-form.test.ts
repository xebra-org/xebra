import { describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_NETWORK = "mainnet";

import type { Delivery } from "../../app/sui/sui-client";
import { classifyWalletError } from "../../lib/wallet-error";
import { afterWalletError, nextDelivery } from "./aptos-bridge-form";

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

describe("afterWalletError", () => {
  const seq = 7n;

  it("keeps a decline as you cancelled, without reading the sequence number", () => {
    const declined = classifyWalletError({ code: 4001, message: "User rejected the request" });
    const r = afterWalletError(declined, null, seq);
    expect(r.kind).toBe("declined");
    expect(r.maybeSent).toBe(false);
  });

  it("says it may have been sent when the sequence number moved past the burn", () => {
    const r = afterWalletError(classifyWalletError("Request timed out"), 8n, seq);
    expect(r.maybeSent).toBe(true);
    expect(r.message).toBe(
      "This transfer may have been sent. Check your wallet before trying again.",
    );
    expect(r.message).not.toMatch(/nothing was sent/i);
  });

  it("says nothing was sent when the sequence number did not move", () => {
    const timedOut = afterWalletError(classifyWalletError("Request timed out"), 7n, seq);
    expect(timedOut.maybeSent).toBe(false);
    expect(timedOut.message).toBe("The transfer did not go out. Nothing was sent.");

    const funds = afterWalletError(classifyWalletError("insufficient balance"), 7n, seq);
    expect(funds.message).toBe(
      "Your wallet does not have enough funds or gas to complete this transfer. Nothing was sent.",
    );
  });

  it("keeps the classifier's maybe-sent wording when the sequence number is unknown", () => {
    const r = afterWalletError(classifyWalletError("Failed to fetch"), null, seq);
    expect(r.kind).toBe("network");
    expect(r.maybeSent).toBe(true);
    expect(r.message).not.toMatch(/nothing was sent/i);
  });

  it("does not repeat nothing was sent", () => {
    const onchain = afterWalletError(classifyWalletError("Move abort 0x1::coin"), 7n, seq);
    expect(onchain.message).toBe("The transaction failed on-chain. Nothing was sent.");
  });
});
