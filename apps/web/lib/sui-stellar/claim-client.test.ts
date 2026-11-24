import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claimOnStellar } from "./claim-client";

vi.mock("../env", () => ({
  env: {
    stellarNetworkPassphrase: "Test SDF Network ; September 2015",
    sorobanRpcUrl: "https://soroban.example.test",
    horizonUrl: "https://horizon.example.test",
  },
}));

const PAYER = "GPAYER";
const DIGEST = "digest-123";

function fakeKit() {
  const signTransaction = vi.fn();
  return { kit: { signTransaction } as unknown as StellarWalletsKit, signTransaction };
}

function stubFetch(body: string, status: number, contentType = "application/json") {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { "content-type": contentType } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claimOnStellar", () => {
  it("treats a 409 with delivered: true as an already-finished transfer", async () => {
    stubFetch(
      JSON.stringify({ error: "This transfer was already completed.", delivered: true }),
      409,
    );
    const { kit, signTransaction } = fakeKit();

    await expect(claimOnStellar(kit, PAYER, DIGEST)).resolves.toEqual({
      hash: "",
      delivered: true,
    });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("works the same for the Aptos and Solana claim routes", async () => {
    const fetchMock = stubFetch(JSON.stringify({ error: "done", delivered: true }), 409);
    const { kit } = fakeKit();

    await expect(
      claimOnStellar(kit, PAYER, "0xabc", { url: "/api/aptos/claim", key: "tx" }),
    ).resolves.toEqual({ hash: "", delivered: true });
    await expect(claimOnStellar(kit, PAYER, DIGEST, "/api/solana-source/claim")).resolves.toEqual({
      hash: "",
      delivered: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the server's error on a 422 that is not delivered", async () => {
    stubFetch(JSON.stringify({ error: "The burn is not attested yet.", delivered: false }), 422);
    const { kit, signTransaction } = fakeKit();

    await expect(claimOnStellar(kit, PAYER, DIGEST)).rejects.toThrow(
      "The burn is not attested yet.",
    );
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("gives a plain message when the server answers with an HTML error page", async () => {
    stubFetch("<html><body>502 Bad Gateway</body></html>", 502, "text/html");
    const { kit, signTransaction } = fakeKit();

    await expect(claimOnStellar(kit, PAYER, DIGEST)).rejects.toThrow(
      "Xebra's server did not answer properly. Nothing was sent; try again in a minute.",
    );
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("gives a plain message on an empty reply", async () => {
    stubFetch("", 500);
    const { kit } = fakeKit();

    await expect(claimOnStellar(kit, PAYER, DIGEST)).rejects.toThrow(
      "Xebra's server did not answer properly",
    );
  });

  it("throws when a 200 reply carries no transaction to sign", async () => {
    stubFetch(JSON.stringify({}), 200);
    const { kit, signTransaction } = fakeKit();

    await expect(claimOnStellar(kit, PAYER, DIGEST)).rejects.toThrow("Could not prepare the mint.");
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
