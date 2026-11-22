import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notFound as aptosNotFound } from "../aptos/config";
import {
  notFound,
  parseSuiSendsToEvm,
  suiEvmDestinations,
  suiSendsToDomain,
  suiSendsToSolana,
} from "./config";

const ids = (value: string | undefined) => parseSuiSendsToEvm(value).map((c) => c.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SUI_SENDS_TO_EVM", () => {
  it("is Monad when unset, as it has been since the route went live", () => {
    expect(ids(undefined)).toEqual(["monad"]);
  });

  it("is nothing for none or an empty value", () => {
    expect(ids("none")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("  ")).toEqual([]);
  });

  it("is every chain in the EVM table for all, in table order, Arc included", () => {
    const all = ids("all");
    expect(all).toEqual(Object.keys(EVM_CHAINS));
    expect(all).toContain("arc");
    expect(ids(" ALL ")).toEqual(all);
  });

  it("keeps the order named, drops repeats, and ignores names it does not know", () => {
    expect(ids("base, monad,base,nonsense,solana")).toEqual(["base", "monad"]);
    // `all` only means every chain on its own; inside a list it is just an unknown name.
    expect(ids("monad,all")).toEqual(["monad"]);
  });

  it("is nothing while the Sui page is off", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "");
    vi.stubEnv("SUI_SENDS_TO_EVM", "all");
    expect(suiEvmDestinations()).toEqual([]);
  });
});

describe("SUI_STELLAR_RELAYER_SECRET", () => {
  /** The warning is given once per server instance, so each test reads a freshly loaded module. */
  async function fresh() {
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { relayerSecret } = await import("./config");
    return { relayerSecret, logged, text: () => logged.mock.calls.flat().join(" ") };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the seed when the value is a Stellar secret seed", async () => {
    const seed = Keypair.random().secret();
    vi.stubEnv("SUI_STELLAR_RELAYER_SECRET", `  ${seed}\n`);
    const { relayerSecret, logged } = await fresh();
    expect(relayerSecret()).toBe(seed);
    expect(logged).not.toHaveBeenCalled();
  });

  it("is off when unset or empty, without a word", async () => {
    const { relayerSecret, logged } = await fresh();
    for (const unset of [undefined, "", "   "]) {
      vi.stubEnv("SUI_STELLAR_RELAYER_SECRET", unset as unknown as string);
      expect(relayerSecret(), String(unset)).toBeNull();
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("is off for a seed with a typo, and says so once without printing it", async () => {
    const seed = Keypair.random().secret();
    const typo = `${seed.slice(0, -1)}${seed.endsWith("A") ? "B" : "A"}`;
    vi.stubEnv("SUI_STELLAR_RELAYER_SECRET", typo);
    const { relayerSecret, logged, text } = await fresh();
    // Asked on every page load: the config routes read it each time.
    expect(relayerSecret()).toBeNull();
    expect(relayerSecret()).toBeNull();
    expect(relayerSecret()).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(text()).toContain("SUI_STELLAR_RELAYER_SECRET");
    // Not the value, and not a recognisable piece of it: one wrong character from a real seed.
    expect(text()).not.toContain(typo);
    expect(text()).not.toContain(typo.slice(0, 8));
    expect(text()).not.toContain(typo.slice(-8));
  });

  it("is off for a public key pasted by mistake, and says that is what it looks like", async () => {
    const pasted = Keypair.random().publicKey();
    vi.stubEnv("SUI_STELLAR_RELAYER_SECRET", pasted);
    const { relayerSecret, logged, text } = await fresh();
    expect(relayerSecret()).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/public key/);
    expect(text()).not.toContain(pasted);
  });

  it("accepts exactly what StrKey.isValidEd25519SecretSeed accepts", async () => {
    const { relayerSecret } = await fresh();
    const accepts = (value: string) => {
      vi.stubEnv("SUI_STELLAR_RELAYER_SECRET", value);
      return relayerSecret() !== null;
    };
    const swap = (s: string, at: number) =>
      `${s.slice(0, at)}${s[at] === "A" ? "B" : "A"}${s.slice(at + 1)}`;
    /** A StrKey built by hand, so one can be made with a correct checksum and the wrong version. */
    const strKey = (version: number, payload: Uint8Array) => {
      const data = [version, ...payload];
      let crc = 0;
      for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
      }
      const bits = [...data, crc & 0xff, crc >> 8]
        .map((byte) => byte.toString(2).padStart(8, "0"))
        .join("");
      return (bits.match(/.{5}/g) ?? [])
        .map((five) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number.parseInt(five, 2)])
        .join("");
    };
    const SEED_VERSION = 18 << 3;

    for (let i = 0; i < 100; i++) {
      const pair = Keypair.random();
      const seed = pair.secret();
      // The hand-built encoder makes real StrKeys, so what it makes next is a fair test.
      expect(strKey(SEED_VERSION, pair.rawSecretKey())).toBe(seed);
      const wrongVersion = strKey(SEED_VERSION + 1 + (i % 7), pair.rawSecretKey());
      expect(wrongVersion.startsWith("S")).toBe(true);
      const candidates = [
        seed,
        // One character changed at each position in turn, the first one (the `S`) included.
        swap(seed, i % seed.length),
        seed.toLowerCase(),
        seed.slice(0, -1),
        `${seed}A`,
        // Starts with S, the right length, a correct checksum, and still not a seed.
        wrongVersion,
        // Every other kind of StrKey is as well formed as a seed, and is not one.
        pair.publicKey(),
        StrKey.encodeContract(pair.rawPublicKey()),
        StrKey.encodePreAuthTx(pair.rawPublicKey()),
        StrKey.encodeSha256Hash(pair.rawPublicKey()),
      ];
      for (const candidate of candidates) {
        expect(accepts(candidate), candidate.slice(0, 1) + candidate.length).toBe(
          StrKey.isValidEd25519SecretSeed(candidate),
        );
      }
      expect(accepts(seed)).toBe(true);
    }
  });
});

describe("SUI_SENDS_TO_SOLANA", () => {
  it("is off unless set to true", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    for (const off of [undefined, "", "1", "yes", "false"]) {
      vi.stubEnv("SUI_SENDS_TO_SOLANA", off as unknown as string);
      expect(suiSendsToSolana(), String(off)).toBe(false);
      expect(suiSendsToDomain(5), String(off)).toBe(false);
    }
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "true");
    expect(suiSendsToSolana()).toBe(true);
    expect(suiSendsToDomain(5)).toBe(true);
  });

  it("is not switched on by SUI_SENDS_TO_EVM=all", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    vi.stubEnv("SUI_SENDS_TO_EVM", "all");
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "");
    expect(suiSendsToDomain(5)).toBe(false);
    expect(suiSendsToDomain(EVM_CHAINS.base.cctpDomainId)).toBe(true);
  });

  it("is off while the Sui page is off", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "");
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "true");
    expect(suiSendsToSolana()).toBe(false);
  });
});

describe("a route whose switch is off", () => {
  it("answers a 404 that says it is switched off, and is never cached", async () => {
    const res = notFound();
    // Still 404: a client that only looks at the status behaves as it always has.
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "This route is switched off on this deployment.",
      code: "feature_disabled",
    });
  });

  it("answers the same from the Aptos routes, which keep their own copy", async () => {
    const [sui, aptos] = [notFound(), aptosNotFound()];
    expect(aptos.status).toBe(sui.status);
    expect([...aptos.headers]).toEqual([...sui.headers]);
    expect(await aptos.json()).toEqual(await sui.json());
  });
});
