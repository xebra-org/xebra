import { describe, expect, it, vi } from "vitest";
import {
  BUILD_TIMED_OUT,
  fetchBeforeSigning,
  nextPollDelay,
  shouldShowPollNotice,
} from "./poll-backoff";

describe("nextPollDelay", () => {
  it("returns the base interval when there are no failures", () => {
    expect(nextPollDelay(0)).toBe(5000);
    expect(nextPollDelay(-1)).toBe(5000);
  });

  it("backs off exponentially on consecutive failures", () => {
    expect(nextPollDelay(1)).toBe(10_000);
    expect(nextPollDelay(2)).toBe(20_000);
    expect(nextPollDelay(3)).toBe(30_000);
  });

  it("caps the delay", () => {
    expect(nextPollDelay(4)).toBe(30_000);
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
  it("stays quiet before 5 consecutive failures", () => {
    expect(shouldShowPollNotice(0)).toBe(false);
    expect(shouldShowPollNotice(4)).toBe(false);
  });

  it("shows from the threshold on", () => {
    expect(shouldShowPollNotice(5)).toBe(true);
    expect(shouldShowPollNotice(20)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldShowPollNotice(2, 3)).toBe(false);
    expect(shouldShowPollNotice(3, 3)).toBe(true);
  });
});

/** A fetch that never answers until its signal aborts, like a hung route. */
const hangs: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("fetchBeforeSigning", () => {
  it("returns the answer and its body", async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ transaction: "abc" }),
    );
    const r = await fetchBeforeSigning<{ transaction: string }>("/api/x/build", { a: 1 }, 1000, f);
    expect(r).toMatchObject({ timedOut: false, body: { transaction: "abc" } });
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a hung request as timed out", async () => {
    expect(await fetchBeforeSigning("/api/x/build", {}, 20, hangs)).toEqual({ timedOut: true });
  });

  it("reports a body that never finishes as timed out", async () => {
    const slowBody: typeof fetch = async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    };
    expect(await fetchBeforeSigning("/api/x/build", {}, 20, slowBody)).toEqual({
      timedOut: true,
    });
  });

  it("throws other failures, so they are never read as nothing sent", async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchBeforeSigning("/api/x/build", {}, 1000, offline)).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("answers a body that is not JSON with a null body", async () => {
    const notJson: typeof fetch = async () => new Response("<html>", { status: 502 });
    const r = await fetchBeforeSigning("/api/x/build", {}, 1000, notJson);
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) {
      expect(r.res.status).toBe(502);
      expect(r.body).toBeNull();
    }
  });

  it("does not treat an error that merely mentions a timeout as one", async () => {
    const wordy: typeof fetch = async () => {
      throw new Error("upstream timed out, request aborted");
    };
    await expect(fetchBeforeSigning("/api/x/build", {}, 1000, wordy)).rejects.toThrow(
      "upstream timed out",
    );
  });
});

describe("BUILD_TIMED_OUT", () => {
  it("is the only timeout that says nothing was sent", () => {
    expect(BUILD_TIMED_OUT.maybeSent).toBe(false);
    expect(BUILD_TIMED_OUT.message).toBe("Xebra did not answer in time. Nothing was sent.");
  });
});
