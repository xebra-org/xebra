import type { rpc } from "@stellar/stellar-sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { type IntentEventSource, pollOpenedIntentsOnce } from "./poll-intents.js";

const HASH = Buffer.alloc(32, 0xab);

function event(topic: string, data: Record<string, unknown>, id = "1-1"): rpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2026-11-04T00:00:00Z",
    pagingToken: id,
    inSuccessfulContractCall: true,
    txHash: `tx-${id}`,
    topic: [nativeToScVal(topic, { type: "symbol" })],
    // The contract emits `dest_chain` as u32; an untyped JS number would become a 64-bit int.
    value: nativeToScVal(data, { type: { dest_chain: ["symbol", "u32"] } }),
  } as unknown as rpc.Api.EventResponse;
}

const OPENED = {
  intent_hash: HASH,
  user: "GUSER",
  source_token: "CTOKEN",
  source_amount: 500_000_000n,
  dest_chain: 3,
  dest_asset: Buffer.alloc(32, 2),
  min_dest_amount: 900_000_000n,
  dest_address: Buffer.alloc(32, 3),
  expiry: 2_000_000_000n,
  nonce: 1n,
};

const page = (events: rpc.Api.EventResponse[], cursor: string): rpc.Api.GetEventsResponse =>
  ({ events, cursor, latestLedger: 100 }) as unknown as rpc.Api.GetEventsResponse;

describe("pollOpenedIntentsOnce", () => {
  it("turns IntentOpened events into intents and advances the cursor", async () => {
    const source: IntentEventSource = {
      getEvents: vi.fn(async () => page([event("intent_opened", OPENED)], "cur-2")),
    };

    const result = await pollOpenedIntentsOnce(source, "cur-1");

    expect(source.getEvents).toHaveBeenCalledWith("cur-1");
    expect(result.cursor).toBe("cur-2");
    expect(result.more).toBe(true);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.intentHash).toBe(`0x${"ab".repeat(32)}`);
    expect(result.intents[0]?.intent.sourceAmount).toBe(500_000_000n);
    expect(result.intents[0]?.intent.minDestAmount).toBe(900_000_000n);
    expect(result.intents[0]?.txRef).toBe("tx-1-1");
  });

  it("ignores every event that is not an IntentOpened", async () => {
    const source: IntentEventSource = {
      getEvents: async () =>
        page(
          [
            event("intent_claimed", { intent_hash: HASH, solver: "GSOLVER" }, "1-2"),
            event("intent_finalized", { intent_hash: HASH }, "1-3"),
            event("something_else", {}, "1-4"),
          ],
          "cur-3",
        ),
    };
    const result = await pollOpenedIntentsOnce(source, undefined);
    expect(result.intents).toEqual([]);
    expect(result.cursor).toBe("cur-3");
  });

  it("reports caught-up and keeps the cursor when the page is empty", async () => {
    const source: IntentEventSource = { getEvents: async () => page([], "") };
    const result = await pollOpenedIntentsOnce(source, "cur-9");
    expect(result).toEqual({ intents: [], cursor: "cur-9", more: false });
  });
});
