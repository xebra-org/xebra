import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
  env: {},
}));

vi.mock("../wallet/wallet-provider", () => ({
  useWallets: () => ({}),
}));

import {
  isTerminalRelayerStatus,
  isTerminalStellarState,
  nextPollDelay,
  shouldShowPollNotice,
} from "./solana-bridge-form";

describe("solana-bridge-form poll helpers", () => {
  describe("nextPollDelay", () => {
    it("returns base interval when there are no failures", () => {
      expect(nextPollDelay(0)).toBe(5000);
      expect(nextPollDelay(-1)).toBe(5000);
    });

    it("backs off exponentially on consecutive failures", () => {
      expect(nextPollDelay(1)).toBe(10_000);
      expect(nextPollDelay(2)).toBe(20_000);
      expect(nextPollDelay(3)).toBe(30_000);
    });

    it("caps delay at maxMs", () => {
      expect(nextPollDelay(4)).toBe(30_000);
      expect(nextPollDelay(5)).toBe(30_000);
      expect(nextPollDelay(10)).toBe(30_000);
    });

    it("respects custom base and max values", () => {
      expect(nextPollDelay(0, 1000, 8000)).toBe(1000);
      expect(nextPollDelay(1, 1000, 8000)).toBe(2000);
      expect(nextPollDelay(2, 1000, 8000)).toBe(4000);
      expect(nextPollDelay(3, 1000, 8000)).toBe(8000);
      expect(nextPollDelay(5, 1000, 8000)).toBe(8000);
    });
  });

  describe("shouldShowPollNotice", () => {
    it("does not show notice before the threshold (5 failures)", () => {
      expect(shouldShowPollNotice(0)).toBe(false);
      expect(shouldShowPollNotice(1)).toBe(false);
      expect(shouldShowPollNotice(4)).toBe(false);
    });

    it("shows notice once reaching or exceeding the threshold", () => {
      expect(shouldShowPollNotice(5)).toBe(true);
      expect(shouldShowPollNotice(6)).toBe(true);
      expect(shouldShowPollNotice(20)).toBe(true);
    });

    it("respects a custom threshold", () => {
      expect(shouldShowPollNotice(2, 3)).toBe(false);
      expect(shouldShowPollNotice(3, 3)).toBe(true);
    });
  });

  describe("isTerminalStellarState", () => {
    it("recognizes completed delivery as terminal", () => {
      expect(isTerminalStellarState("complete", true, undefined)).toBe(true);
    });

    it("recognizes refusal as terminal", () => {
      expect(isTerminalStellarState("complete", false, "Circle rejected message")).toBe(true);
    });

    it("recognizes pending or incomplete states as non-terminal", () => {
      expect(isTerminalStellarState("pending", false, undefined)).toBe(false);
      expect(isTerminalStellarState("unknown", false, undefined)).toBe(false);
      expect(isTerminalStellarState("complete", false, undefined)).toBe(false);
    });
  });

  describe("isTerminalRelayerStatus", () => {
    it("recognizes terminal statuses", () => {
      expect(isTerminalRelayerStatus("delivered")).toBe(true);
      expect(isTerminalRelayerStatus("refused")).toBe(true);
      expect(isTerminalRelayerStatus("failed")).toBe(true);
    });

    it("recognizes in-progress statuses as non-terminal", () => {
      expect(isTerminalRelayerStatus("submitted")).toBe(false);
      expect(isTerminalRelayerStatus("pending")).toBe(false);
      expect(isTerminalRelayerStatus(undefined)).toBe(false);
    });
  });
});
