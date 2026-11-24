import { afterEach, describe, expect, it, vi } from "vitest";
import { readSource } from "./routes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A bad value is reported once per server instance, so each test loads the module afresh. */
async function fresh(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv("STELLAR_CCTP_DOMAIN_ID", value as unknown as string);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { stellarDomainId } = await import("./iris");
  return { stellarDomainId, logged };
}

describe("STELLAR_CCTP_DOMAIN_ID", () => {
  for (const absent of [undefined, "", "   "]) {
    it(`is 27 when ${absent === undefined ? "unset" : JSON.stringify(absent)}, without a word`, async () => {
      const { stellarDomainId, logged } = await fresh(absent);
      expect(stellarDomainId()).toBe(27);
      expect(logged).not.toHaveBeenCalled();
    });
  }

  it("is the domain it names when that is a non-negative whole number", async () => {
    const { stellarDomainId, logged } = await fresh("27");
    expect(stellarDomainId()).toBe(27);
    // The override is honoured for any whole number, not only 27 spelled out.
    for (const [value, domain] of [
      ["0", 0],
      ["5", 5],
      [" 42 ", 42],
    ] as const) {
      vi.stubEnv("STELLAR_CCTP_DOMAIN_ID", value);
      expect(stellarDomainId(), value).toBe(domain);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  for (const bad of ["abc", "-1", "2.5", "27abc", "1e2", "0x1b", "NaN", "99999999999999999999"]) {
    it(`is 27 for ${JSON.stringify(bad)}, and says so once`, async () => {
      const { stellarDomainId, logged } = await fresh(bad);
      // Read on every status request.
      expect(stellarDomainId()).toBe(27);
      expect(stellarDomainId()).toBe(27);
      expect(stellarDomainId()).toBe(27);
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).toContain("STELLAR_CCTP_DOMAIN_ID");
      expect(line).toContain(JSON.stringify(bad));
      expect(line).toContain("27");
    });
  }

  it("keeps Stellar readable as a source when the variable is nonsense", async () => {
    const { stellarDomainId } = await fresh("abc");
    // With NaN here, `src=27` matched nothing and the route answered 400, blaming the caller, and
    // a bare `?tx=` was looked up under a domain of NaN.
    expect(readSource("27", stellarDomainId())).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource(null, stellarDomainId())).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource("", stellarDomainId())).toEqual({ domain: 27, kind: "stellar" });
  });
});
