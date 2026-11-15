import { describe, expect, it } from "vitest";
import { pickLastBurn } from "./last-burn";

const SENDER = "0x0732135dcce723c5f48d03a527068f1d1f6b7fd318c3afcbf2927e1ee26222cb";
const DFB =
  "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830::deposit_for_burn::DepositForBurn";

function tx(
  digest: string,
  opts: { type?: string; depositor?: string; domain?: number; status?: string } = {},
) {
  return {
    digest,
    effects: {
      status: opts.status ?? "SUCCESS",
      events: {
        nodes: [
          {
            contents: {
              type: { repr: opts.type ?? DFB },
              json: { depositor: opts.depositor ?? SENDER, destination_domain: opts.domain ?? 27 },
            },
          },
        ],
      },
    },
  };
}

const plain = (digest: string) => ({
  digest,
  effects: { status: "SUCCESS", events: { nodes: [] } },
});

describe("pickLastBurn", () => {
  it("takes the newest burn (GraphQL `last` lists oldest first)", () => {
    const nodes = [tx("a", { domain: 15 }), plain("b"), tx("c", { domain: 27 }), plain("d")];
    expect(pickLastBurn(nodes, SENDER)).toEqual({ digest: "c", destinationDomain: 27 });
  });

  it("is null when the address has sent no burn", () => {
    expect(pickLastBurn([plain("a"), plain("b")], SENDER)).toBeNull();
  });

  it("ignores a look-alike event from another package", () => {
    const fake = tx("x", { type: "0xbad::deposit_for_burn::DepositForBurn" });
    expect(pickLastBurn([tx("a"), fake], SENDER)).toEqual({ digest: "a", destinationDomain: 27 });
  });

  it("ignores a burn whose depositor is someone else", () => {
    expect(pickLastBurn([tx("a", { depositor: `0x${"1".repeat(64)}` })], SENDER)).toBeNull();
  });

  it("ignores a failed transaction", () => {
    expect(pickLastBurn([tx("a", { status: "FAILURE" })], SENDER)).toBeNull();
  });

  it("matches the address whatever its case", () => {
    expect(pickLastBurn([tx("a")], SENDER.toUpperCase().replace("0X", "0x"))?.digest).toBe("a");
  });
});
