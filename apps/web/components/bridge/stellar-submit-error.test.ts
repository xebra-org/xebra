import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
  env: { stellarNetworkPassphrase: "Public Global Stellar Network ; September 2015" },
  isCctpRailConfigured: true,
}));
vi.mock("../wallet/wallet-provider", () => ({ useWallets: () => ({}) }));
vi.mock("./beneficiary-picker", () => ({ BeneficiaryPicker: () => null }));
vi.mock("./use-beneficiaries", () => ({ useBeneficiaries: () => ({}) }));

import { UncertainSubmitError } from "../../lib/cctp-bridge";
import { classifyStellarSubmitError } from "./stellar-bridge-form";

describe("classifyStellarSubmitError", () => {
  it("keeps UncertainSubmitError hash-bearing message and marks maybeSent=true", () => {
    const hash = "a".repeat(64);
    const err = new UncertainSubmitError(hash, "burn", new Error("socket hang up"));
    const classified = classifyStellarSubmitError(err);

    expect(classified).toEqual({
      kind: "network",
      message: err.message,
      maybeSent: true,
      raw: err.message,
    });
    expect(classified.message).toContain(hash);
  });

  it("preserves Soroban TRY_AGAIN_LATER refusals instead of misclassifying them as wallet declines", () => {
    const msg =
      "The network declined to queue the burn right now (TRY_AGAIN_LATER). Nothing has moved. Wait a few seconds and try again.";
    const classified = classifyStellarSubmitError(new Error(msg));

    expect(classified).toEqual({
      kind: "unknown",
      message: msg,
      maybeSent: false,
      raw: msg,
    });
  });

  it("delegates wallet declines and network timeouts to classifyWalletError", () => {
    expect(classifyStellarSubmitError({ code: 4001, message: "User rejected" }).kind).toBe(
      "declined",
    );
    const timedOut = classifyStellarSubmitError(new Error("Request timed out"));
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.maybeSent).toBe(true);
  });
});
