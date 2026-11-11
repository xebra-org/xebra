import type { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { encodeBridgeRequest } from "./stellar.js";

/**
 * The encoding contract between this app and `contracts/stellar-cctp-wrapper-v2`.
 *
 * These assertions exist because `nativeToScVal` guesses when it is not told, and a wrong guess
 * fails as `Error(Value, UnexpectedType)` out of `map_unpack_to_linear_memory` — an error that
 * names no field and no type. The only way to find it was a live mainnet attempt.
 *
 * If the contract's `BridgeRequest` ever changes, this file is what should fail first.
 */

const REQUEST = {
  user: "GBFI4X5ERTTOBZ22N54INR5ELPRLSIDGN7ZIXHZDH5CBIMDYFVSQSJHM",
  amount: 100_000_000n,
  destinationDomain: 5,
  mintRecipient: new Uint8Array(32).fill(7),
  maxFee: 1_770_000n,
  minFinalityThreshold: 2000,
  recipientNeedsAccount: false,
  recipientOwner: new Uint8Array(32),
  approvalExpirationLedger: 64_352_174,
  maxWrapperFee: 3_000_000n,
  deadline: 1_788_985_381n,
};

/** Field name -> the XDR discriminant the contract declares for it. */
const EXPECTED: Record<string, string> = {
  user: "scvAddress",
  amount: "scvI128",
  destination_domain: "scvU32",
  mint_recipient: "scvBytes",
  max_fee: "scvI128",
  min_finality_threshold: "scvU32",
  recipient_needs_account: "scvBool",
  recipient_owner: "scvBytes",
  approval_expiration_ledger: "scvU32",
  max_wrapper_fee: "scvI128",
  deadline: "scvU64",
};

function entries(val: xdr.ScVal) {
  return (val.map() ?? []).map((e) => ({
    key: e.key(),
    keyType: e.key().switch().name,
    name: e.key().sym().toString(),
    valType: e.val().switch().name,
  }));
}

describe("encodeBridgeRequest", () => {
  it("produces a map, as a #[contracttype] struct requires", () => {
    expect(encodeBridgeRequest(REQUEST).switch().name).toBe("scvMap");
  });

  it("keys every field with a symbol, not a string", () => {
    // A JS object's string keys default to scvString. Soroban struct maps are keyed by symbol,
    // so a string-keyed map carries the right names and the wrong key type and cannot unpack.
    for (const e of entries(encodeBridgeRequest(REQUEST))) {
      expect(e.keyType, e.name).toBe("scvSymbol");
    }
  });

  it("gives every field the exact type the contract declares", () => {
    for (const e of entries(encodeBridgeRequest(REQUEST))) {
      expect(e.valType, e.name).toBe(EXPECTED[e.name]);
    }
  });

  it("sends all eleven fields and no others", () => {
    const names = entries(encodeBridgeRequest(REQUEST))
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
  });

  it("keeps i128 fields at i128 regardless of how small the value is", () => {
    // The real trap: the SDK picks the narrowest integer that fits, so the encoding depends on
    // the amount. A request could encode correctly at one value and fail at another.
    for (const amount of [0n, 1n, 100_000_000n, 2n ** 100n]) {
      const found = entries(encodeBridgeRequest({ ...REQUEST, amount })).find(
        (e) => e.name === "amount",
      );
      expect(found?.valType, `amount=${amount}`).toBe("scvI128");
    }
  });

  it("keeps u32 fields at u32 for small domain ids", () => {
    // destination_domain is 5 on Solana — small enough that every narrower type fits it.
    const found = entries(encodeBridgeRequest({ ...REQUEST, destinationDomain: 5 })).find(
      (e) => e.name === "destination_domain",
    );
    expect(found?.valType).toBe("scvU32");
  });

  it("sends the mint recipient as 32 bytes", () => {
    // Circle enforces recipient_token_account.key() == mint_recipient. A short or long value is
    // a transfer that can never be minted.
    const found = (encodeBridgeRequest(REQUEST).map() ?? []).find(
      (e) => e.key().sym().toString() === "mint_recipient",
    );
    expect(found?.val().bytes()).toHaveLength(32);
  });

  it("sends the recipient owner as 32 bytes, zeroes when there is none", () => {
    const owner = (o: Uint8Array) =>
      (encodeBridgeRequest({ ...REQUEST, recipientOwner: o }).map() ?? [])
        .find((e) => e.key().sym().toString() === "recipient_owner")
        ?.val()
        .bytes();
    const arr = (b?: Uint8Array) => Array.from(b ?? []);
    expect(arr(owner(new Uint8Array(32)))).toEqual(new Array(32).fill(0));
    expect(arr(owner(new Uint8Array(32).fill(9)))).toEqual(new Array(32).fill(9));
  });
});
