import { describe, expect, it } from "vitest";
import {
  type BurnReading,
  findBurnAfterFailure,
  isDeclined,
  isNetworkError,
  sendFailureMessage,
} from "./sui-send-check";

const OLD = { digest: "F7qiEMaT7q7pbfQ2H44SeV4URQQVfNpffmpt3J5yH8pD", destinationDomain: 15 };
const NEW = { digest: "8T2tpkfWYxXH7GdKWs3774XePqvjS6JJsSENCVX4Phn4", destinationDomain: 27 };
const noWait = async () => {};

/** A reader that answers from a script, one reading per call; the last one repeats. */
function reads(...seq: BurnReading[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    read: async () => {
      calls.push(i);
      const v = seq[Math.min(i, seq.length - 1)];
      i++;
      return v;
    },
  };
}

describe("findBurnAfterFailure", () => {
  it("finds a burn the wallet sent before it reported an error", async () => {
    const r = reads(NEW);
    const check = await findBurnAfterFailure("0xabc", OLD, { read: r.read, wait: noWait });
    expect(check).toEqual({ kind: "found", burn: NEW });
  });

  it("keeps looking while Sui's index catches up", async () => {
    const r = reads(OLD, OLD, NEW);
    const check = await findBurnAfterFailure("0xabc", OLD, { read: r.read, wait: noWait });
    expect(check).toEqual({ kind: "found", burn: NEW });
    expect(r.calls).toHaveLength(3);
  });

  it("finds a first-ever burn when the wallet had none before", async () => {
    const r = reads(NEW);
    expect(await findBurnAfterFailure("0xabc", null, { read: r.read, wait: noWait })).toEqual({
      kind: "found",
      burn: NEW,
    });
  });

  it("says none when every look shows only the old burn", async () => {
    const r = reads(OLD);
    const check = await findBurnAfterFailure("0xabc", OLD, { read: r.read, wait: noWait });
    expect(check).toEqual({ kind: "none" });
    expect(r.calls).toHaveLength(4);
  });

  it("cannot promise anything without a reading from before signing", async () => {
    const r = reads(NEW);
    expect(await findBurnAfterFailure("0xabc", undefined, { read: r.read, wait: noWait })).toEqual({
      kind: "unknown",
    });
    expect(r.calls).toHaveLength(0);
  });

  it("is unknown when the last look failed, never none", async () => {
    const r = reads(OLD, OLD, OLD, undefined);
    expect(await findBurnAfterFailure("0xabc", OLD, { read: r.read, wait: noWait })).toEqual({
      kind: "unknown",
    });
  });
});

describe("isNetworkError", () => {
  it("knows the Android wallet's DNS failure from the field", () => {
    expect(
      isNetworkError(
        'fetch failed: java.net.UnknownHostException: Unable to resolve host "mysten-rpc.mainnet.sui.io": No address associated with hostname',
      ),
    ).toBe(true);
  });

  it("knows browser network failures", () => {
    expect(isNetworkError("TypeError: Failed to fetch")).toBe(true);
    expect(isNetworkError("Load failed")).toBe(true);
    expect(isNetworkError("Request timed out")).toBe(true);
  });

  it("leaves chain and wallet errors alone", () => {
    expect(isNetworkError("Insufficient USDC balance")).toBe(false);
    expect(isNetworkError("User rejected the request")).toBe(false);
  });
});

describe("isDeclined", () => {
  it("reads the ways wallets say no", () => {
    for (const text of [
      "User rejected the request.",
      "Transaction declined",
      "Permission denied",
      "Cancelled",
      "The user closed the popup",
      "Popup closed",
      "Request dismissed",
    ]) {
      expect(isDeclined(text), text).toBe(true);
    }
  });

  it("does not take a dropped connection for a decline", () => {
    for (const text of [
      "Connection closed",
      "socket closed before the request finished",
      "Request cancelled: network request failed",
      "fetch failed: java.net.UnknownHostException",
    ]) {
      expect(isDeclined(text), text).toBe(false);
    }
  });
});

describe("sendFailureMessage", () => {
  const dns = "fetch failed: java.net.UnknownHostException: Unable to resolve host";

  it("tells plainly that nothing was sent when Sui shows nothing", () => {
    const m = sendFailureMessage(dns, "none");
    expect(m).toContain("nothing was sent");
    expect(m).not.toContain("java");
  });

  it("asks the person to look first when it could not check", () => {
    const m = sendFailureMessage(dns, "unknown");
    expect(m).toContain("could not confirm");
    expect(m).toContain("so you do not send twice");
    expect(m).not.toContain("nothing was sent");
  });

  it("keeps the wallet's own words for other errors", () => {
    expect(sendFailureMessage("Insufficient gas", "none")).toMatch(
      /^Insufficient gas Nothing was sent/,
    );
  });
});
