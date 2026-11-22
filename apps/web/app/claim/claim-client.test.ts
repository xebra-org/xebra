import { describe, expect, it, vi } from "vitest";
import { CIRCLE_UNAVAILABLE_MESSAGE, mapAttestationResponse } from "./claim-client";

// The client component pulls in the wallet provider chain through ./evm-claim,
// which does not load under vitest. The mapping function under test touches none
// of that, so the component module is stubbed out here.
vi.mock("./evm-claim", () => ({ EvmClaim: () => null }));

const COMPLETE = {
  status: "complete",
  message: "0x01",
  attestation: "0x02",
  usdcMint: "mint",
  sourceDomainId: 0,
  destinationDomain: 5,
};

describe("mapAttestationResponse", () => {
  it("200 complete passes the attestation through", () => {
    expect(mapAttestationResponse(200, COMPLETE)).toEqual({
      kind: "attestation",
      attestation: COMPLETE,
    });
  });

  it("200 pending passes the attestation through", () => {
    expect(mapAttestationResponse(200, { status: "pending" })).toEqual({
      kind: "attestation",
      attestation: { status: "pending" },
    });
  });

  it("200 unknown with a Circle reason is Circle being unreachable, not a wrong hash", () => {
    expect(
      mapAttestationResponse(200, { status: "unknown", reason: "Circle returned 500" }),
    ).toEqual({ kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE });
    expect(
      mapAttestationResponse(200, {
        status: "unknown",
        reason: "Circle lookups are paused for a moment; try again shortly",
      }),
    ).toEqual({ kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE });
  });

  it("200 unknown with any other reason is a real not-found", () => {
    expect(
      mapAttestationResponse(200, {
        status: "unknown",
        reason: "no CCTP message in that transaction",
      }),
    ).toEqual({ kind: "not-found", reason: "no CCTP message in that transaction" });
    expect(
      mapAttestationResponse(200, {
        status: "unknown",
        reason: "Circle has not indexed this burn yet",
      }),
    ).toEqual({ kind: "not-found", reason: "Circle has not indexed this burn yet" });
  });

  it("400 shows the server's error", () => {
    expect(
      mapAttestationResponse(400, { error: "src is not a chain transfers start from" }),
    ).toEqual({ kind: "input-error", message: "src is not a chain transfers start from" });
  });

  it("400 without an error still says something useful", () => {
    const outcome = mapAttestationResponse(400, {});
    expect(outcome.kind).toBe("input-error");
  });

  it("404 is a real not-found", () => {
    expect(mapAttestationResponse(404, { status: "unknown" })).toEqual({
      kind: "not-found",
      reason: "Circle has no message for that transaction.",
    });
  });

  it("502 says Circle is not answering", () => {
    expect(
      mapAttestationResponse(502, { status: "unknown", reason: "Circle returned 500" }),
    ).toEqual({ kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE });
  });

  it("503 says Circle is not answering", () => {
    expect(
      mapAttestationResponse(503, {
        status: "unknown",
        reason: "Circle lookups are paused for a moment; try again shortly",
      }),
    ).toEqual({ kind: "circle-unavailable", message: CIRCLE_UNAVAILABLE_MESSAGE });
  });
});
