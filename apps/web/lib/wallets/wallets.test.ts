import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { describe, expect, it } from "vitest";
import {
  applyEvmEvent,
  connectEvm,
  evmEntries,
  parseChainId,
  reduceAnnouncements,
  safeIcon,
} from "./evm";
import { isSolanaWallet, pickSolanaAccount, solanaEntries } from "./solana";
import { keepDetected, stellarEntries } from "./stellar";
import type { Connection, Eip1193Provider, WalletEntry } from "./types";

const provider = (accounts: unknown): Eip1193Provider => ({
  request: async () => accounts,
});
const detail = (rdns: string, name: string, icon = "data:image/svg+xml;base64,AAAA") => ({
  info: { uuid: rdns, name, icon, rdns },
  provider: provider([]),
});

describe("EIP-6963", () => {
  it("keys announcements by rdns so a repeat is one wallet", () => {
    let m = reduceAnnouncements(new Map(), detail("io.metamask", "MetaMask"));
    m = reduceAnnouncements(m, detail("io.metamask", "MetaMask"));
    m = reduceAnnouncements(m, detail("app.phantom", "Phantom"));
    expect(evmEntries(m, null).map((e) => e.name)).toEqual(["MetaMask", "Phantom"]);
  });
  it("ignores malformed announcements", () => {
    let m = reduceAnnouncements(new Map(), null);
    m = reduceAnnouncements(m, { info: { rdns: 1 }, provider: {} });
    m = reduceAnnouncements(m, { info: { rdns: "x", name: "X" } });
    expect(m.size).toBe(0);
  });
  it("keeps an icon that has whitespace around it, as Phantom announces it", () => {
    const m = reduceAnnouncements(
      new Map(),
      detail("app.phantom", "Phantom", "\ndata:image/png;base64,iVBORw0KGgo="),
    );
    expect(evmEntries(m, null)[0]?.icon).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(safeIcon("  https://x/y.png \n")).toBe("https://x/y.png");
  });
  it("still drops a script URL that is padded with whitespace", () => {
    expect(safeIcon("\n javascript:alert(1)")).toBeNull();
    expect(safeIcon(42)).toBeNull();
  });
  it("drops icons that are not data: images or https", () => {
    const m = reduceAnnouncements(new Map(), detail("evil", "Evil", "javascript:alert(1)"));
    expect(evmEntries(m, null)[0]?.icon).toBeNull();
  });
  it("offers the legacy global only when nothing announced", () => {
    expect(evmEntries(new Map(), provider([]))[0]?.key).toBe("evm:injected");
    expect(evmEntries(new Map(), null)).toEqual([]);
    const m = reduceAnnouncements(new Map(), detail("io.metamask", "MetaMask"));
    expect(evmEntries(m, provider([])).some((e) => e.key === "evm:injected")).toBe(false);
  });
  it("connects and validates the address", async () => {
    const entry = evmEntries(reduceAnnouncements(new Map(), detail("a", "A")), null)[0];
    if (!entry) throw new Error("no entry");
    const good = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
    expect((await connectEvm(entry, provider([good]))).address).toBe(good);
    await expect(connectEvm(entry, provider([]))).rejects.toThrow(/address/);
    await expect(connectEvm(entry, provider(["nope"]))).rejects.toThrow(/address/);
  });
});

describe("the EVM wallet's network", () => {
  const A = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
  const B = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
  const conn: Connection = {
    family: "evm",
    walletKey: "evm:a",
    walletName: "A",
    address: A,
    chainId: 1,
  };

  it("is read at connect, and its absence does not stop the connection", async () => {
    const entry = evmEntries(reduceAnnouncements(new Map(), detail("a", "A")), null)[0];
    if (!entry) throw new Error("no entry");
    const answering: Eip1193Provider = {
      request: async ({ method }) => (method === "eth_chainId" ? "0x2105" : [A]),
    };
    expect((await connectEvm(entry, answering)).chainId).toBe(8453);
    const silent: Eip1193Provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") throw new Error("unsupported");
        return [A];
      },
    };
    expect((await connectEvm(entry, silent)).chainId).toBeUndefined();
  });

  it("follows a network switch", () => {
    expect(applyEvmEvent(conn, { type: "chainChanged", chainId: "0x13b2" })?.chainId).toBe(5042);
  });

  it("keeps the network when the account changes, and the account when the network changes", () => {
    const onArc = applyEvmEvent(conn, { type: "chainChanged", chainId: "0x13b2" });
    const switched = applyEvmEvent(onArc, { type: "accountsChanged", accounts: [B] });
    expect(switched).toMatchObject({ address: B, chainId: 5042 });
    expect(applyEvmEvent(switched, { type: "chainChanged", chainId: "0x1" })).toMatchObject({
      address: B,
      chainId: 1,
    });
  });

  it("forgets the network when told something that is not one, instead of keeping a stale one", () => {
    expect(applyEvmEvent(conn, { type: "chainChanged", chainId: 8453 })?.chainId).toBeUndefined();
    expect(parseChainId("0x0")).toBeUndefined();
    expect(parseChainId("8453")).toBeUndefined();
  });

  it("drops the connection when the wallet has no account left for us", () => {
    expect(applyEvmEvent(conn, { type: "accountsChanged", accounts: [] })).toBeNull();
    expect(applyEvmEvent(conn, { type: "accountsChanged", accounts: ["nope"] })).toBeNull();
    expect(applyEvmEvent(null, { type: "chainChanged", chainId: "0x1" })).toBeNull();
  });
});

const fakeWallet = (name: string, chains: string[], connect = true) =>
  ({
    name,
    icon: "data:image/png;base64,AAAA",
    version: "1.0.0",
    chains,
    features: connect ? { "standard:connect": {} } : {},
    accounts: [],
  }) as unknown as Wallet;

describe("Wallet Standard (Solana)", () => {
  it("keeps only Solana wallets that can connect", () => {
    const list = [
      fakeWallet("Phantom", ["solana:mainnet"]),
      fakeWallet("Rabby", ["eip155:1"]),
      fakeWallet("NoConnect", ["solana:mainnet"], false),
    ];
    expect(list.map(isSolanaWallet)).toEqual([true, false, false]);
    expect(solanaEntries(list).map((e) => e.name)).toEqual(["Phantom"]);
  });
  it("prefers a Solana account when a wallet is multi-chain", () => {
    const acct = (address: string, chains: string[]) =>
      ({ address, chains }) as unknown as WalletAccount;
    const picked = pickSolanaAccount([
      acct("0xabc", ["eip155:1"]),
      acct("SoL111", ["solana:mainnet"]),
    ]);
    expect(picked?.address).toBe("SoL111");
    expect(pickSolanaAccount([acct("0xabc", ["eip155:1"])])).toBeNull();
  });
});

describe("Stellar detection", () => {
  const entry = (id: string, installed: boolean): WalletEntry => ({
    key: `stellar:${id}`,
    family: "stellar",
    name: id,
    icon: null,
    installed,
  });
  // The kit is asked for icons only; its own availability answer must play no part.
  const kit = {
    getSupportedWallets: async () => [
      { id: "freighter", icon: "https://x/f.png", isAvailable: false },
      { id: "lobstr", icon: "https://x/l.png", isAvailable: false },
    ],
  } as unknown as Parameters<typeof stellarEntries>[0];

  it("takes availability from the page's own probe, not the kit's 500 ms one", async () => {
    const out = await stellarEntries(kit, async (id) => id === "lobstr");
    expect(out.map((e) => [e.name, e.installed])).toEqual([
      ["Freighter", false],
      ["LOBSTR", true],
    ]);
    expect(out[1]?.icon).toBe("https://x/l.png");
  });

  it("reads no answer as not found", async () => {
    const out = await stellarEntries(kit, async () => null);
    expect(out.every((e) => !e.installed)).toBe(true);
  });

  it("does not take back a detected wallet when a later check gets no answer", () => {
    const out = keepDetected(
      [entry("freighter", true), entry("lobstr", false)],
      [entry("freighter", false), entry("lobstr", false)],
    );
    expect(out.map((e) => e.installed)).toEqual([true, false]);
  });

  it("marks a newly detected wallet", () => {
    const out = keepDetected([entry("lobstr", false)], [entry("lobstr", true)]);
    expect(out[0]?.installed).toBe(true);
  });
});
