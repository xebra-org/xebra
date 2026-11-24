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

import { StellarTxNotFoundError, txMaxTimeMs, waitForTx } from "../../lib/cctp-bridge";
import {
  HORIZON_INGEST_GRACE_MS,
  STELLAR_RECHECK_MAX_ROUNDS,
  classifyStellarWaitError,
  mapStellarBurnResult,
  pollPendingStellarBurn,
  stellarExplorerTxUrl,
} from "./stellar-bridge-form";

const SAMPLE_TX_HASH = "a".repeat(64);

describe("mapStellarBurnResult", () => {
  it("transitions to a burned receipt and enables Circle polling once Stellar confirms", () => {
    expect(mapStellarBurnResult("confirmed", SAMPLE_TX_HASH)).toEqual({
      kind: "burned",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      pollCircle: true,
    });
  });

  it("maps an on-chain FAILED outcome to the plain-words alarm notice with explorer link and stops Circle polling", () => {
    expect(mapStellarBurnResult("failed", SAMPLE_TX_HASH)).toEqual({
      kind: "failed",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      message:
        "Stellar did not accept the burn. No USDC left your wallet. Only the network fee was spent.",
      pollCircle: false,
    });
  });

  it("maps an expired outcome to a not-sent notice with the hash and explorer link and unlocks retry", () => {
    expect(mapStellarBurnResult("expired", SAMPLE_TX_HASH)).toEqual({
      kind: "not-sent",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      message:
        "Stellar did not confirm the burn before its time bound expired, so it was not sent. No USDC left your wallet. It is safe to try again.",
      pollCircle: false,
    });
  });

  it("maps a wait timeout to 'Waiting for Stellar to confirm' rather than polling Circle", () => {
    expect(
      mapStellarBurnResult("timeout", SAMPLE_TX_HASH, "Test SDF Network ; September 2015"),
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
      { round: 1, maxRounds: STELLAR_RECHECK_MAX_ROUNDS },
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
      { round: 2, maxRounds: STELLAR_RECHECK_MAX_ROUNDS },
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

  const HORIZON = { horizonUrl: "https://horizon.stellar.org" };
  const PUBLIC = "Public Global Stellar Network ; September 2015";
  const MAX_TIME_MS = 1_700_000_120_000;
  const SETTLED_MS = MAX_TIME_MS + HORIZON_INGEST_GRACE_MS;

  it("marks the burn not-sent only when Horizon answered 404 after the transaction's time bound", async () => {
    const waitFn = vi
      .fn()
      .mockRejectedValue(
        new StellarTxNotFoundError("timed out", SAMPLE_TX_HASH, SETTLED_MS + 1_000),
      );
    const next = await pollPendingStellarBurn(HORIZON, SAMPLE_TX_HASH, PUBLIC, waitFn, {
      round: 1,
      deadlineMs: MAX_TIME_MS,
      nowMs: SETTLED_MS + 2_000,
    });
    expect(next).toEqual({
      kind: "not-sent",
      txHash: SAMPLE_TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${SAMPLE_TX_HASH}`,
      message:
        "Stellar did not confirm the burn before its time bound expired, so it was not sent. No USDC left your wallet. It is safe to try again.",
      pollCircle: false,
    });
  });

  it("keeps waiting while the time bound is still open, even on a 404 and an exhausted round count", async () => {
    const waitFn = vi
      .fn()
      .mockRejectedValue(new StellarTxNotFoundError("timed out", SAMPLE_TX_HASH, MAX_TIME_MS - 1));
    const next = await pollPendingStellarBurn(HORIZON, SAMPLE_TX_HASH, PUBLIC, waitFn, {
      round: STELLAR_RECHECK_MAX_ROUNDS,
      maxRounds: STELLAR_RECHECK_MAX_ROUNDS,
      deadlineMs: MAX_TIME_MS,
      nowMs: MAX_TIME_MS - 1,
    });
    expect(next).toMatchObject({ kind: "waiting-stellar", deadlineMs: MAX_TIME_MS });
  });

  it("never says not-sent when a 404 came before the bound plus Horizon's ingest grace", async () => {
    const waitFn = vi
      .fn()
      .mockRejectedValue(new StellarTxNotFoundError("timed out", SAMPLE_TX_HASH, MAX_TIME_MS + 1));
    const next = await pollPendingStellarBurn(HORIZON, SAMPLE_TX_HASH, PUBLIC, waitFn, {
      round: STELLAR_RECHECK_MAX_ROUNDS,
      maxRounds: STELLAR_RECHECK_MAX_ROUNDS,
      deadlineMs: MAX_TIME_MS,
      nowMs: SETTLED_MS + 2_000,
    });
    expect(next.kind).toBe("unconfirmed");
  });

  it("is unconfirmed, never not-sent, when every Horizon call fails", async () => {
    // Real waitForTx, short timings, against a Horizon that cannot be reached and then one that 503s.
    const fastWait: typeof waitForTx = (config, txHash) => waitForTx(config, txHash, 30, 5);
    const failures: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
    ];
    for (const fail of failures) {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(fail));
      for (const options of [
        { round: 1, deadlineMs: MAX_TIME_MS, nowMs: SETTLED_MS + 2_000 },
        {
          round: STELLAR_RECHECK_MAX_ROUNDS,
          maxRounds: STELLAR_RECHECK_MAX_ROUNDS,
          deadlineMs: MAX_TIME_MS,
          nowMs: SETTLED_MS + 2_000,
        },
        { round: STELLAR_RECHECK_MAX_ROUNDS, maxRounds: STELLAR_RECHECK_MAX_ROUNDS },
      ]) {
        const next = await pollPendingStellarBurn(
          HORIZON,
          SAMPLE_TX_HASH,
          PUBLIC,
          fastWait,
          options,
        );
        expect(next.kind).not.toBe("not-sent");
        expect(next.txHash).toBe(SAMPLE_TX_HASH);
      }
      const exhausted = await pollPendingStellarBurn(HORIZON, SAMPLE_TX_HASH, PUBLIC, fastWait, {
        round: STELLAR_RECHECK_MAX_ROUNDS,
        maxRounds: STELLAR_RECHECK_MAX_ROUNDS,
        deadlineMs: MAX_TIME_MS,
        nowMs: SETTLED_MS + 2_000,
      });
      expect(exhausted).toMatchObject({ kind: "unconfirmed", txHash: SAMPLE_TX_HASH });
      if (exhausted.kind === "unconfirmed") {
        expect(exhausted.message).toMatch(/stellar\.expert before trying again/);
        expect(exhausted.message).not.toMatch(/safe to try again/);
      }
    }
    vi.unstubAllGlobals();
  });
});

describe("waitForTx", () => {
  it("throws StellarTxNotFoundError only when Horizon's latest answer was a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const notFound = await waitForTx({ horizonUrl: "https://h.example" }, "tx1", 30, 5).catch(
      (e: unknown) => e,
    );
    expect(notFound).toBeInstanceOf(StellarTxNotFoundError);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockRejectedValue(new TypeError("fetch failed")),
    );
    const unreachable = await waitForTx({ horizonUrl: "https://h.example" }, "tx1", 30, 5).catch(
      (e: unknown) => e,
    );
    expect(unreachable).toBeInstanceOf(Error);
    expect(unreachable).not.toBeInstanceOf(StellarTxNotFoundError);
    vi.unstubAllGlobals();
  });
});

describe("txMaxTimeMs", () => {
  it("reads the signed transaction's maxTime, and treats 0 as no bound", () => {
    type Tx = Parameters<typeof txMaxTimeMs>[0];
    expect(
      txMaxTimeMs({ timeBounds: { minTime: "0", maxTime: "1700000120" } } as unknown as Tx),
    ).toBe(1_700_000_120_000);
    expect(
      txMaxTimeMs({ timeBounds: { minTime: "0", maxTime: "0" } } as unknown as Tx),
    ).toBeUndefined();
    expect(
      txMaxTimeMs({
        innerTransaction: { timeBounds: { minTime: "0", maxTime: "1700000060" } },
      } as unknown as Tx),
    ).toBe(1_700_000_060_000);
  });
});
