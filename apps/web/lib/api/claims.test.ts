import { encodeReceiveMessage } from "@xebra/cctp-evm";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import { EVM_SENDER, EVM_TX, SENDER, SOLANA_WALLET, STELLAR_TX, buildDeps, deps } from "./fakes";
import { createService } from "./service";

const DIGEST = "37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7";

const svc = (over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) =>
  createService(deps({ build: buildDeps(over), ...top }));

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

describe("buildClaim: EVM destinations", () => {
  it("returns receiveMessage on the destination's transmitter, checked as the payer", async () => {
    const evmClaimCheck = vi.fn(async () => ({ state: "open" as const }));
    const { steps } = await svc({ evmClaimCheck }).buildClaim({
      chain: "stellar",
      tx: STELLAR_TX,
      payer: EVM_SENDER,
    });
    const base = EVM_CHAINS.base;
    expect(evmClaimCheck).toHaveBeenCalledWith(base, EVM_SENDER, "0x01", "0x02");
    expect(steps).toEqual([
      expect.objectContaining({
        id: "claim",
        chain: "base",
        tx: {
          kind: "evm",
          chainId: base.chainId,
          to: base.messageTransmitterAddress,
          data: encodeReceiveMessage("0x01", "0x02"),
          value: "0",
        },
      }),
    ]);
  });

  it("refuses a transfer that was already minted, so nobody pays twice", async () => {
    const err = await refusal(
      svc({ evmClaimCheck: async () => ({ state: "delivered" }) }).buildClaim({
        chain: "stellar",
        tx: STELLAR_TX,
        payer: EVM_SENDER,
      }),
    );
    expect(err).toMatchObject({ code: "already_delivered", status: 409 });
  });

  it("refuses a mint that would revert, with the chain's reason", async () => {
    const err = await refusal(
      svc({
        evmClaimCheck: async () => ({ state: "refused", reason: "Invalid signature" }),
      }).buildClaim({
        chain: "stellar",
        tx: STELLAR_TX,
        payer: EVM_SENDER,
      }),
    );
    expect(err.code).toBe("transaction_rejected");
    expect(err.detail).toContain("Invalid signature");
  });

  it("says not yet while Circle has not attested", async () => {
    const err = await refusal(
      svc({ attestation: async () => ({ status: "pending" }) }).buildClaim({
        chain: "arc",
        tx: EVM_TX,
        payer: EVM_SENDER,
      }),
    );
    expect(err.code).toBe("not_ready");
  });

  it("asks Circle about the burn on the chain it was made on", async () => {
    const attestation = vi.fn(async () => ({ status: "pending" }));
    await refusal(svc({ attestation }).buildClaim({ chain: "arc", tx: EVM_TX, payer: EVM_SENDER }));
    expect(attestation).toHaveBeenCalledWith(EVM_TX, EVM_CHAINS.arc.cctpDomainId);
  });

  it("refuses a payer from the wrong chain family", async () => {
    const err = await refusal(
      svc().buildClaim({ chain: "stellar", tx: STELLAR_TX, payer: SENDER }),
    );
    expect(err.code).toBe("invalid_request");
  });
});

describe("buildClaim: Solana", () => {
  const toSolana = {
    attestation: async () => ({
      status: "complete",
      message: "0x01",
      attestation: "0x02",
      destinationDomain: 5,
      sourceDomainId: 27,
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
  };

  it("opens the recipient's account first when it is missing", async () => {
    const { steps } = await svc({
      ...toSolana,
      solanaClaim: async () => ({ state: "ready", setup: "c2V0dXA=", mint: "bWludA==" }),
    }).buildClaim({
      chain: "stellar",
      tx: STELLAR_TX,
      payer: SOLANA_WALLET,
      recipientOwner: SOLANA_WALLET,
    });
    expect(steps.map((s) => [s.id, s.tx])).toEqual([
      ["open_account", { kind: "solana", transaction: "c2V0dXA=" }],
      ["claim", { kind: "solana", transaction: "bWludA==" }],
    ]);
  });

  it("asks for the account's owner when it must be opened and was not given", async () => {
    const err = await refusal(
      svc({
        ...toSolana,
        solanaClaim: async () => ({ state: "needs-owner", reason: "no USDC account" }),
      }).buildClaim({ chain: "stellar", tx: STELLAR_TX, payer: SOLANA_WALLET }),
    );
    expect(err).toMatchObject({ code: "invalid_request", extra: { needs: "recipientOwner" } });
  });
});

describe("buildClaim: Sui to Stellar", () => {
  it("returns the Stellar mint for the payer to sign", async () => {
    const { steps } = await svc().buildClaim({ chain: "sui", tx: DIGEST, payer: SENDER });
    expect(steps[0]).toMatchObject({
      id: "claim",
      chain: "stellar",
      tx: { kind: "stellar", xdr: "AAAA" },
    });
  });

  it("refuses one already delivered, and says not yet before attestation", async () => {
    const done = await refusal(
      svc({
        suiClaim: async () => ({ ok: false, reason: "delivered", delivered: true }),
      }).buildClaim({
        chain: "sui",
        tx: DIGEST,
        payer: SENDER,
      }),
    );
    expect(done.code).toBe("already_delivered");
    const early = await refusal(
      svc({
        suiClaim: async () => ({ ok: false, reason: "Circle has not attested this burn yet." }),
      }).buildClaim({
        chain: "sui",
        tx: DIGEST,
        payer: SENDER,
      }),
    );
    expect(early.code).toBe("not_ready");
  });
});

describe("transferStatus: Sui", () => {
  const on = { suiStellar: { enabled: true, maxUnits: null } };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ state: "pending" }, "pending"],
    [{ state: "unknown", reason: "Circle has not indexed this burn yet" }, "pending"],
    [{ state: "complete", delivered: true }, "delivered"],
    [{ state: "complete", delivered: false }, "needs_claim"],
    [{ state: "complete", delivered: false, refusal: "not a burn to Stellar" }, "failed"],
  ];
  for (const [answer, state] of cases) {
    it(`reads ${JSON.stringify(answer)} as ${state}`, async () => {
      const s = svc({}, { ...on, suiStatus: async () => answer });
      expect((await s.transferStatus({ chain: "sui", tx: DIGEST })).state).toBe(state);
    });
  }

  it("is unavailable while Sui to Stellar is off", async () => {
    const err = await refusal(
      svc({}, { suiStatus: async () => ({ state: "pending" }) }).transferStatus({
        chain: "sui",
        tx: DIGEST,
      }),
    );
    expect(err.code).toBe("route_unavailable");
  });
});
