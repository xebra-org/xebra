import { describe, expect, it } from "vitest";
import { XRPL_RPCS, xrpAccount, xrpDeliveryProblem } from "./xrpl";

const BINANCE = "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh";
const NEW = "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp";

/** A fake XRPL JSON-RPC server: account flags by address, the reserve from server_state. */
function ledger(accounts: Record<string, number>, opts: { down?: string[] } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (opts.down?.includes(url)) throw new TypeError("fetch failed");
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: [{ account?: string }];
    };
    if (body.method === "server_state") {
      return Response.json({
        result: { state: { validated_ledger: { reserve_base: 1_000_000, reserve_inc: 200_000 } } },
      });
    }
    const account = body.params[0].account ?? "";
    if (!(account in accounts)) {
      return Response.json({ result: { error: "actNotFound", status: "error" } });
    }
    return Response.json({
      result: { account_data: { Account: account, Flags: accounts[account] }, status: "success" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("xrpAccount", () => {
  it("reads an exchange's require-destination-tag flag (Binance, read live 2026-11-28: 131072)", async () => {
    const { fetchImpl } = ledger({ [BINANCE]: 131072 });
    expect(await xrpAccount(BINANCE, fetchImpl)).toEqual({
      exists: true,
      requireDestTag: true,
      depositAuth: false,
      reserveDrops: 1_000_000n,
    });
  });

  it("reports an account that is not open yet", async () => {
    const { fetchImpl } = ledger({});
    expect(await xrpAccount(NEW, fetchImpl)).toMatchObject({
      exists: false,
      requireDestTag: false,
    });
  });

  it("tries the next public server when one is down", async () => {
    const { fetchImpl, calls } = ledger({ [NEW]: 0 }, { down: [XRPL_RPCS[0] as string] });
    expect(await xrpAccount(NEW, fetchImpl)).toMatchObject({ exists: true });
    expect(calls).toContain(XRPL_RPCS[1]);
  });

  it("fails rather than guess when no server answers", async () => {
    const { fetchImpl } = ledger({}, { down: [...XRPL_RPCS] });
    await expect(xrpAccount(NEW, fetchImpl)).rejects.toThrow(/couldn't check this XRP account/);
  });
});

describe("xrpDeliveryProblem", () => {
  const open = {
    exists: true,
    requireDestTag: false,
    depositAuth: false,
    reserveDrops: 1_000_000n,
  };

  it("passes an ordinary open wallet", () => {
    expect(xrpDeliveryProblem(open)).toBeNull();
    expect(xrpDeliveryProblem(open, "500000")).toBeNull();
  });

  it("refuses an account that needs a destination tag, saying why", () => {
    expect(xrpDeliveryProblem({ ...open, requireDestTag: true })).toMatch(
      /needs a destination tag.*exchange/,
    );
  });

  it("refuses an account that only takes payments from approved senders", () => {
    expect(xrpDeliveryProblem({ ...open, depositAuth: true })).toMatch(/approved/);
  });

  it("refuses to open a new account with less than the ledger's reserve", () => {
    const fresh = { ...open, exists: false };
    expect(xrpDeliveryProblem(fresh)).toBeNull(); // amount not known yet
    expect(xrpDeliveryProblem(fresh, "999999")).toMatch(/isn't open yet.*at least 1 XRP/);
    expect(xrpDeliveryProblem(fresh, "1000000")).toBeNull();
  });
});
