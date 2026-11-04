import { describe, expect, it, vi } from "vitest";
import { waitForTransaction } from "./horizon-wait.js";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function deps(responses: Array<Response | Error>) {
  let t = 0;
  const queue = [...responses];
  return {
    fetch: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe("waitForTransaction", () => {
  it("keeps waiting through 404 until the transaction is applied", async () => {
    const d = deps([json(404, {}), json(404, {}), json(200, { successful: true })]);
    await expect(
      waitForTransaction("https://h.example/", "abc", 60_000, d),
    ).resolves.toBeUndefined();
    expect(d.fetch).toHaveBeenCalledTimes(3);
    expect(d.fetch).toHaveBeenCalledWith("https://h.example/transactions/abc", expect.anything());
  });

  it("rethrows a transaction that landed and failed", async () => {
    const d = deps([json(200, { successful: false })]);
    await expect(waitForTransaction("https://h.example", "abc", 60_000, d)).rejects.toThrow(
      /included in a ledger but failed/,
    );
  });

  it("rides out a network blip", async () => {
    const d = deps([new Error("ETIMEDOUT"), json(200, { successful: true })]);
    await expect(
      waitForTransaction("https://h.example", "abc", 60_000, d),
    ).resolves.toBeUndefined();
  });

  it("times out when it never appears", async () => {
    const d = deps(Array.from({ length: 50 }, () => json(404, {})));
    await expect(waitForTransaction("https://h.example", "abc", 10_000, d)).rejects.toThrow(
      /timed out/,
    );
  });
});
