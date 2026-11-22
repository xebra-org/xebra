import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as buildSuiBurn } from "../../app/api/sui-stellar/build/route";
import { maxUsdcBase } from "../sui-stellar/config";
import { parseCap } from "./parse-cap";

/** A variable name no other test has used: an unreadable value is reported once per name. */
let n = 0;
const fresh = () => `TEST_MAX_USDC_${++n}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseCap", () => {
  it("is no cap when the variable is unset or empty", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const absent of [undefined, "", "   "]) {
      expect(parseCap(fresh(), absent), JSON.stringify(absent)).toBeNull();
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("is that cap, in base units, for a positive amount", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCap(fresh(), "250")).toBe(250_000_000n);
    expect(parseCap(fresh(), "0.5")).toBe(500_000n);
    expect(parseCap(fresh(), "  10  ")).toBe(10_000_000n);
    expect(parseCap(fresh(), "0.000001")).toBe(1n);
    expect(logged).not.toHaveBeenCalled();
  });

  // Each of these used to mean no cap at all.
  for (const unreadable of ["1,000", "$500", "0", "-1", "abc", "1e3", "0.0000001", "250 USDC"]) {
    it(`fails closed on ${JSON.stringify(unreadable)}: a cap of zero, and one line saying why`, () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const name = fresh();
      expect(parseCap(name, unreadable)).toBe(0n);
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]?.[0]);
      // Which variable, what it holds, and what happens until it is fixed.
      expect(line).toContain(name);
      expect(line).toContain(JSON.stringify(unreadable));
      expect(line).toMatch(/every transfer .* is refused/);
    });
  }

  it("reports an unreadable value once per variable, however often it is read", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const [one, other] = [fresh(), fresh()];
    // The config route reads the cap on every page load.
    expect(parseCap(one, "1,000")).toBe(0n);
    expect(parseCap(one, "1,000")).toBe(0n);
    expect(parseCap(one, "1,000")).toBe(0n);
    expect(logged).toHaveBeenCalledTimes(1);
    // A second variable with the same mistake is its own report.
    expect(parseCap(other, "1,000")).toBe(0n);
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

describe("SUI_STELLAR_MAX_USDC", () => {
  it("is read through parseCap, so a mistyped cap refuses transfers instead of lifting the limit", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SUI_STELLAR_MAX_USDC", "");
    expect(maxUsdcBase()).toBeNull();
    vi.stubEnv("SUI_STELLAR_MAX_USDC", "250");
    expect(maxUsdcBase()).toBe(250_000_000n);
    vi.stubEnv("SUI_STELLAR_MAX_USDC", "1,000");
    expect(maxUsdcBase()).toBe(0n);
  });

  it("makes the build route refuse a transfer, which is what failing closed has to mean", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    const build = (amount: string) =>
      buildSuiBurn(
        new Request("https://xebra.test/api/sui-stellar/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: `0x${"ab".repeat(32)}`,
            recipient: Keypair.random().publicKey(),
            amount,
          }),
        }),
      );

    // The smallest amount there is, under a cap that cannot be read. The route answers before it
    // reads any chain, so nothing here touches the network.
    vi.stubEnv("SUI_STELLAR_MAX_USDC", "$500");
    const refused = await build("0.000001");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "The limit is 0 USDC per transfer." });

    // A cap that can be read still stops what is over it, and names its own figure.
    vi.stubEnv("SUI_STELLAR_MAX_USDC", "500");
    const over = await build("500.000001");
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({ error: "The limit is 500 USDC per transfer." });
  });
});
