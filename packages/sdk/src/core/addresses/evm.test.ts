import { PRESETS } from "@xebra/network-config";
import { describe, expect, it } from "vitest";
import { EVM_CHAINS } from "../chains/evm.js";
import { checkAddressOn, unsafeRecipientsFor } from "./evm.js";

// Foundry's first anvil account: public, with a documented EIP-55 form.
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("checkAddressOn", () => {
  it("accepts a wallet on any chain and returns it left-padded to 32 bytes", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      const r = checkAddressOn(chain, WALLET);
      expect(r.ok, chain.id).toBe(true);
      expect([...(r.bytes as Uint8Array).slice(0, 12)]).toEqual(new Array(12).fill(0));
    }
  });

  it("names the chain the address is for, with the right article", () => {
    expect(checkAddressOn(EVM_CHAINS.base, "0x1234").error).toBe(
      "A Base address is 0x followed by 40 hex characters.",
    );
    expect(checkAddressOn(EVM_CHAINS.arbitrum, "0x1234").error).toBe(
      "An Arbitrum address is 0x followed by 40 hex characters.",
    );
    expect(
      checkAddressOn(EVM_CHAINS.polygon, "343zLQT4rL96rh6uNas2vm7gDSiv9CQ8dAFa8qvw2di5").error,
    ).toBe("That looks like a Solana address, not a Polygon one.");
  });

  it("refuses each chain's own USDC token and Circle's contracts on it", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      for (const [address, what] of Object.entries(unsafeRecipientsFor(chain))) {
        const r = checkAddressOn(chain, address);
        expect(r.ok, `${chain.id} ${address}`).toBe(false);
        expect(r.error).toContain(what);
      }
    }
  });

  it("does not refuse one chain's USDC token as a recipient on another", () => {
    // Base's USDC address is just an address on Arc. Refusing it there would be a rule with no
    // reason behind it.
    expect(checkAddressOn(EVM_CHAINS.arc, EVM_CHAINS.base.usdcAddress).ok).toBe(true);
  });

  it("refuses the zero address, burn addresses and a failed checksum everywhere", () => {
    const chain = EVM_CHAINS.arbitrum;
    expect(checkAddressOn(chain, `0x${"00".repeat(20)}`).error).toMatch(/zero address/);
    expect(checkAddressOn(chain, "0x000000000000000000000000000000000000dEaD").error).toMatch(
      /system or burn address/,
    );
    expect(checkAddressOn(chain, `${WALLET.slice(0, -1)}7`).error).toMatch(/checksum/);
  });
});

describe("checkAddressOn for Arc", () => {
  const arc = EVM_CHAINS.arc;

  it("keeps Arc's wording", () => {
    expect(checkAddressOn(arc, "0x1234").error).toBe(
      "An Arc address is 0x followed by 40 hex characters.",
    );
    expect(checkAddressOn(arc, "343zLQT4rL96rh6uNas2vm7gDSiv9CQ8dAFa8qvw2di5").error).toBe(
      "That looks like a Solana address, not an Arc one.",
    );
  });

  it("returns the address left-padded to 32 bytes, the shape the wrapper requires", () => {
    const r = checkAddressOn(arc, WALLET);
    expect(r.bytes).toHaveLength(32);
    expect(Buffer.from((r.bytes as Uint8Array).slice(12)).toString("hex")).toBe(
      WALLET.slice(2).toLowerCase(),
    );
  });

  it("is empty until the user types, without shouting an error at them", () => {
    expect(checkAddressOn(arc, "")).toEqual({ ok: false });
    expect(checkAddressOn(arc, "   ")).toEqual({ ok: false });
  });

  it("accepts all-lowercase and all-uppercase, which carry no checksum to fail, and trims", () => {
    expect(checkAddressOn(arc, WALLET.toLowerCase()).ok).toBe(true);
    expect(checkAddressOn(arc, `0x${WALLET.slice(2).toUpperCase()}`).ok).toBe(true);
    expect(checkAddressOn(arc, `  ${WALLET}\n`).ok).toBe(true);
  });

  it("refuses anything that is not 0x plus 40 hex characters, and the precompile range", () => {
    for (const bad of [
      "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      `${WALLET}00`,
      `0x${"zz".repeat(20)}`,
      "vitalik.eth",
    ]) {
      expect(checkAddressOn(arc, bad).ok, bad).toBe(false);
    }
    expect(checkAddressOn(arc, "0x0000000000000000000000000000000000000001").error).toMatch(
      /system or burn/,
    );
  });

  it("refuses the pinned Circle contracts and USDC token on Arc", () => {
    const { usdcAddress, tokenMessengerAddress, messageTransmitterAddress } = PRESETS.mainnet.arc;
    for (const pinned of [usdcAddress, tokenMessengerAddress, messageTransmitterAddress]) {
      expect(Object.keys(unsafeRecipientsFor(arc))).toContain(pinned.toLowerCase());
    }
  });
});
