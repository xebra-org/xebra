import { describe, expect, it } from "vitest";
import { createRelayKick } from "./relay-kick";

const DIGEST = "37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7";

function harness(answer: () => Promise<Record<string, unknown> | null>) {
  let clock = 0;
  const runs: string[] = [];
  const queued: Array<() => Promise<void>> = [];
  const kick = createRelayKick({
    run: async (digest) => {
      runs.push(digest);
      return answer();
    },
    schedule: (task) => {
      queued.push(task);
    },
    cooldownMs: 60_000,
    now: () => clock,
  });
  return {
    kick,
    runs,
    flush: async () => {
      for (const task of queued.splice(0)) await task();
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createRelayKick", () => {
  it("starts one relay after the response and answers scheduled", async () => {
    const h = harness(async () => ({ status: "submitted", hash: "ab12" }));
    expect(await h.kick(DIGEST)).toEqual({ status: "scheduled" });
    expect(h.runs).toEqual([]);
    await h.flush();
    expect(h.runs).toEqual([DIGEST]);
  });

  it("does not start a second relay while the first runs", async () => {
    const h = harness(async () => ({ status: "submitted", hash: "ab12" }));
    await h.kick(DIGEST);
    expect((await h.kick(DIGEST)).status).toBe("pending");
    await h.flush();
    expect(h.runs).toHaveLength(1);
  });

  it("answers the relayer's word during the cooldown, then relays again", async () => {
    const h = harness(async () => ({ status: "refused", reason: "no trustline" }));
    await h.kick(DIGEST);
    await h.flush();
    expect(await h.kick(DIGEST)).toEqual({ status: "refused", reason: "no trustline" });
    h.advance(60_000);
    expect(await h.kick(DIGEST)).toEqual({ status: "scheduled" });
    await h.flush();
    expect(h.runs).toHaveLength(2);
  });

  it("retries at once when the relay could not be read", async () => {
    const h = harness(async () => {
      throw new Error("network");
    });
    await h.kick(DIGEST);
    await h.flush();
    expect(await h.kick(DIGEST)).toEqual({ status: "scheduled" });
  });

  it("runs the relay unscheduled when there is no request to attach it to", async () => {
    const runs: string[] = [];
    const kick = createRelayKick({
      run: async (digest) => {
        runs.push(digest);
        return { status: "delivered" };
      },
      schedule: () => {
        throw new Error("`after` was called outside a request scope");
      },
    });
    expect(await kick(DIGEST)).toEqual({ status: "scheduled" });
    await Promise.resolve();
    expect(runs).toEqual([DIGEST]);
  });
});
