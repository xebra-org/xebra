import { describe, expect, it, vi } from "vitest";

// Stub client-only modules pulled in by the component file; the pure mapping helpers under test
// touch none of them.
vi.mock("../../lib/env", () => ({
  env: { stellarNetworkPassphrase: "Public Global Stellar Network ; September 2015" },
  isCctpRailConfigured: true,
}));
vi.mock("../wallet/wallet-provider", () => ({ useWallets: () => ({}) }));
vi.mock("./beneficiary-picker", () => ({ BeneficiaryPicker: () => null }));
vi.mock("./use-beneficiaries", () => ({ useBeneficiaries: () => ({}) }));

import {
  classifyStellarWaitError,
  mapStellarBurnResult,
  pollPendingStellarBurn,
  stellarExplorerTxUrl,
} from "./stellar-bridge-form";

const SAMPLE_TX_HASH = "a".repeat(64);

describe("mapStellarBurnResult", () => {
  it("transitions to a burned receipt and enables Circle polling once Stellar confirms", () => {
    expect(mapStellarBurnResult("PENDING", "confirmed", SAMPLE_TX_HASH)).toEqual({
      kind: "burned",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      pollCircle: true,
    });
  });

  it("maps an on-chain FAILED outcome to the plain-words alarm notice with explorer link and stops Circle polling", () => {
    expect(mapStellarBurnResult("PENDING", "failed", SAMPLE_TX_HASH)).toEqual({
      kind: "failed",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      message:
        "Stellar did not accept the burn. No USDC left your wallet. Only the network fee was spent.",
      pollCircle: false,
    });
  });

  it("maps a wait timeout to 'Waiting for Stellar to confirm' rather than polling Circle", () => {
    expect(
      mapStellarBurnResult(
        "PENDING",
        "timeout",
        SAMPLE_TX_HASH,
        "Test SDF Network ; September 2015",
      ),
    ).toEqual({
      kind: "waiting-stellar",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${SAMPLE_TX_HASH}`,
      statusText: "Waiting for Stellar to confirm",
      pollCircle: false,
    });
  });
});

describe("classifyStellarWaitError", () => {
  it("recognises ledger failure errors from waitForTx", () => {
    expect(
      classifyStellarWaitError(
        new Error(
          `Transaction ${SAMPLE_TX_HASH} was included in a ledger but failed. Nothing has moved.`,
        ),
      ),
    ).toBe("failed");
  });

  it("treats wait timeouts and non-rejection wait errors as unresolved Stellar confirmation", () => {
    expect(
      classifyStellarWaitError(
        new Error(`Timed out after 90s waiting for ${SAMPLE_TX_HASH} to be applied.`),
      ),
    ).toBe("timeout");
    expect(classifyStellarWaitError(new Error("Horizon returned 503 while checking tx."))).toBe(
      "timeout",
    );
  });
});

describe("stellarExplorerTxUrl", () => {
  it("uses the testnet explorer when given the Stellar testnet passphrase", () => {
    expect(stellarExplorerTxUrl(SAMPLE_TX_HASH, "Test SDF Network ; September 2015")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${SAMPLE_TX_HASH}`,
    );
    expect(stellarExplorerTxUrl(SAMPLE_TX_HASH)).toBe(
      `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
    );
  });
});

describe("pollPendingStellarBurn", () => {
  it("Horizon slow, then confirms: keeps waiting-stellar until confirmed, then promotes to burned for Circle polling", async () => {
    const waitFn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(`Timed out after 15s waiting for ${SAMPLE_TX_HASH} to be applied.`),
      )
      .mockResolvedValueOnce(undefined);

    const first = await pollPendingStellarBurn(
      { horizonUrl: "https://horizon.stellar.org" },
      SAMPLE_TX_HASH,
      "Public Global Stellar Network ; September 2015",
      waitFn,
    );
    expect(first).toEqual({
      kind: "waiting-stellar",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      statusText: "Waiting for Stellar to confirm",
      pollCircle: false,
    });

    const second = await pollPendingStellarBurn(
      { horizonUrl: "https://horizon.stellar.org" },
      SAMPLE_TX_HASH,
      "Public Global Stellar Network ; September 2015",
      waitFn,
    );
    expect(second).toEqual({
      kind: "burned",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      pollCircle: true,
    });
    expect(waitFn).toHaveBeenCalledTimes(2);
  });

  it("Horizon slow, then fails on chain: transitions to failed notice instead of staying stuck waiting", async () => {
    const waitFn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          `Transaction ${SAMPLE_TX_HASH} was included in a ledger but failed. Nothing has moved.`,
        ),
      );

    const next = await pollPendingStellarBurn(
      { horizonUrl: "https://horizon.stellar.org" },
      SAMPLE_TX_HASH,
      "Public Global Stellar Network ; September 2015",
      waitFn,
    );
    expect(next).toEqual({
      kind: "failed",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      message:
        "Stellar did not accept the burn. No USDC left your wallet. Only the network fee was spent.",
      pollCircle: false,
    });
  });
});
