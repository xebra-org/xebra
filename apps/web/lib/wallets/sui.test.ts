import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { describe, expect, it } from "vitest";
import { isSuiWallet, pickSuiAccount, suiEntries } from "./sui";

const feats = (...names: string[]) => Object.fromEntries(names.map((n) => [n, {}]));

function wallet(
  name: string,
  chains: string[],
  features: string[],
  icon = "data:image/png;base64,AA",
): Wallet {
  return {
    name,
    chains,
    icon,
    features: feats(...features),
    accounts: [],
    version: "1.0.0",
  } as unknown as Wallet;
}

const account = (address: string, chains: string[]) =>
  ({ address, chains }) as unknown as WalletAccount;

describe("isSuiWallet", () => {
  it("accepts a wallet that connects and signs-and-executes on Sui", () => {
    expect(
      isSuiWallet(
        wallet("W", ["sui:mainnet"], ["standard:connect", "sui:signAndExecuteTransaction"]),
      ),
    ).toBe(true);
  });

  it("rejects a Solana wallet", () => {
    expect(
      isSuiWallet(wallet("P", ["solana:mainnet"], ["standard:connect", "solana:signTransaction"])),
    ).toBe(false);
  });

  it("rejects a Sui wallet that cannot sign-and-execute", () => {
    expect(
      isSuiWallet(wallet("W", ["sui:mainnet"], ["standard:connect", "sui:signTransaction"])),
    ).toBe(false);
  });
});

describe("suiEntries", () => {
  it("lists only Sui wallets, sorted, and drops icons that are not data or https URLs", () => {
    const entries = suiEntries([
      wallet(
        "Zed",
        ["sui:mainnet"],
        ["standard:connect", "sui:signAndExecuteTransaction"],
        "http://x/i.png",
      ),
      wallet("Phantom", ["solana:mainnet"], ["standard:connect"]),
      wallet("Alpha", ["sui:mainnet"], ["standard:connect", "sui:signAndExecuteTransaction"]),
    ]);
    expect(entries.map((e) => e.name)).toEqual(["Alpha", "Zed"]);
    expect(entries[1]?.icon).toBeNull();
  });
});

describe("pickSuiAccount", () => {
  it("prefers an account enabled for mainnet", () => {
    const picked = pickSuiAccount([
      account("0xa", ["sui:testnet"]),
      account("0xb", ["sui:mainnet"]),
    ]);
    expect(picked?.address).toBe("0xb");
  });

  it("falls back to any Sui account, and returns null for none", () => {
    expect(pickSuiAccount([account("0xa", ["sui:testnet"])])?.address).toBe("0xa");
    expect(pickSuiAccount([account("S", ["solana:mainnet"])])).toBeNull();
  });
});
