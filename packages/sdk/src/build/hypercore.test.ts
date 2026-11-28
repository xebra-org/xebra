import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildHyperliquidFee,
  buildHyperliquidWithdrawal,
  hyperliquidExchangeBody,
  solanaForwardData,
} from "./hypercore.js";
import type { UnsignedTx } from "./types.js";

/**
 * Golden vectors. Everything under `PY` was computed with Python's `eth_account` 0.13.7 (an
 * EIP-712 implementation that shares no code with viem), from the field lists in Circle's how-tos
 * ("Withdraw USDC from HyperCore to EVM chains" / "…to Solana") and Hyperliquid's exchange-endpoint
 * docs (UsdSend, SpotSend). `HL_SDK` is Hyperliquid's own test vector from
 * hyperliquid-python-sdk `tests/signing_test.py::test_sign_usd_transfer_action`.
 *
 * The keys are public test keys (Anvil account #0, and the Python SDK's test key). Never fund them.
 */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NONCE = 1795870421000;
const FEE_ADDRESS = "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ATA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

const PY = {
  solanaData:
    "0x636374702d666f7277617264000000000000000000000000017e8c088760bfde1dddcf32c17f209b8242ee52aaf131facd88d0ea2c6d0b06f2",
  arcPerps: {
    digest: "0xa7e71c29088f2484da7264601244ad389798c34577b48750c0079bedadf97fa5",
    signature:
      "0x8da6240f9b06e8681ae648b94212916fca60ea6fab26d9c8415b3278056255996331a3daad13c9ea0d95946efa7f05af1aa8747b8e2c89cb78ba03ed3fce337a1b",
  },
  solanaSpot: {
    digest: "0xf3b131a1067ebf297754cc8385c2a93ac4d9ad36b9f12a40d59a32e312c2ff2d",
    signature:
      "0x974544c9559c03f7ac9369288d5d67bad280cf9d5f270378cac266edb30fb3a16e64674aff15d430d2aa9ae401dedb61c4f7a424a67534a7da2ccfc178c023351b",
  },
  usdSend: {
    digest: "0x9c352227e198e4b7e01092b99d81857efa2a4ff8358e2b458b9dae91cead2413",
    signature:
      "0xccf0e7660acc21a20b021902de2cbb5662523a416a7afdfeb0015be5f5e2db6561678087dba5cad042adcda392e7d9012286250264b1f8e794ee14891254fc471b",
  },
  spotSend: {
    digest: "0x062b90169cb6f869800d38954682dd4d7576e11f7ab2e361fa29ad168ff2ee8f",
    signature:
      "0x27ae80359a6fd02d10d870c477069a605c4e08045fbbcdada753072d49d4ca984662e4d1b838a3fef53a502f70f84cada17a0efdef5a11c95743c7e1c76050c61b",
  },
} as const;

type HyperliquidTx = Extract<UnsignedTx, { kind: "hyperliquid" }>;

function sign(tx: HyperliquidTx, key: `0x${string}` = KEY) {
  // A wallet gets the typed data as JSON (`eth_signTypedData_v4`): sign what survives a round trip.
  const typedData = JSON.parse(JSON.stringify(tx.typedData));
  return privateKeyToAccount(key).signTypedData(typedData);
}

const arcPerps = () =>
  buildHyperliquidWithdrawal({
    amount: 9_979_000n,
    balance: "perps",
    destinationDomain: 26,
    recipient: { encoding: "hex", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    nonce: NONCE,
    signatureChainId: 42161,
  });

describe("buildHyperliquidWithdrawal", () => {
  it("builds the action Circle documents for an EVM chain, to the byte", async () => {
    const tx = arcPerps();
    expect(tx.kind).toBe("hyperliquid");
    expect(tx.nonce).toBe(NONCE);
    expect(tx.exchangeUrl).toBe("https://api.hyperliquid.xyz/exchange");
    expect(tx.action).toEqual({
      type: "sendToEvmWithData",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      token: "USDC",
      amount: "9.979",
      sourceDex: "",
      // Lower-cased, as Hyperliquid's own app sends it.
      destinationRecipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      addressEncoding: "hex",
      destinationChainId: 26,
      gasLimit: 200000,
      data: "0x",
      nonce: NONCE,
    });
    expect(tx.typedData.primaryType).toBe("HyperliquidTransaction:SendToEvmWithData");
    expect(tx.typedData.domain).toEqual({
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42161,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(hashTypedData(JSON.parse(JSON.stringify(tx.typedData)))).toBe(PY.arcPerps.digest);
    expect(await sign(tx)).toBe(PY.arcPerps.signature);
  });

  it("builds the Solana action: the token account in base58, and Circle's open-the-account hook", async () => {
    const tx = buildHyperliquidWithdrawal({
      amount: 24_500_000n,
      balance: "spot",
      destinationDomain: 5,
      recipient: { encoding: "base58", tokenAccount: ATA, owner: OWNER },
      nonce: NONCE,
      signatureChainId: 8453,
    });
    expect(tx.action).toMatchObject({
      signatureChainId: "0x2105",
      sourceDex: "spot",
      destinationRecipient: ATA,
      addressEncoding: "base58",
      destinationChainId: 5,
      data: PY.solanaData,
    });
    expect(hashTypedData(JSON.parse(JSON.stringify(tx.typedData)))).toBe(PY.solanaSpot.digest);
    expect(await sign(tx)).toBe(PY.solanaSpot.signature);
  });

  it("signs only what is posted: the message is the action less its type and signatureChainId", () => {
    const tx = arcPerps();
    const { type: _t, signatureChainId: _c, ...rest } = tx.action;
    expect(tx.typedData.message).toEqual(rest);
  });

  it("refuses Stellar, Sui, Aptos and the burn's own chain, whatever the caller checked", () => {
    for (const destinationDomain of [27, 8, 9, 19, 29, 30, 31]) {
      expect(() =>
        buildHyperliquidWithdrawal({
          amount: 5_000_000n,
          balance: "perps",
          destinationDomain,
          recipient: { encoding: "hex", address: SIGNER },
          nonce: NONCE,
          signatureChainId: 42161,
        }),
      ).toThrow();
    }
  });

  it("refuses a recipient in the wrong encoding for its chain", () => {
    expect(() =>
      buildHyperliquidWithdrawal({
        amount: 5_000_000n,
        balance: "perps",
        destinationDomain: 5,
        recipient: { encoding: "hex", address: SIGNER },
        nonce: NONCE,
        signatureChainId: 42161,
      }),
    ).toThrow(/Solana/);
    expect(() =>
      buildHyperliquidWithdrawal({
        amount: 5_000_000n,
        balance: "perps",
        destinationDomain: 6,
        recipient: { encoding: "base58", tokenAccount: ATA, owner: OWNER },
        nonce: NONCE,
        signatureChainId: 42161,
      }),
    ).toThrow(/EVM/);
  });

  it("refuses a malformed address, amount, nonce or chain id", () => {
    const ok = {
      amount: 5_000_000n,
      balance: "perps" as const,
      destinationDomain: 6,
      recipient: { encoding: "hex" as const, address: SIGNER },
      nonce: NONCE,
      signatureChainId: 42161,
    };
    expect(() => buildHyperliquidWithdrawal(ok)).not.toThrow();
    expect(() =>
      buildHyperliquidWithdrawal({ ...ok, recipient: { encoding: "hex", address: "0x1234" } }),
    ).toThrow();
    expect(() =>
      buildHyperliquidWithdrawal({
        ...ok,
        recipient: { encoding: "hex", address: "0x0000000000000000000000000000000000000000" },
      }),
    ).toThrow();
    expect(() =>
      buildHyperliquidWithdrawal({
        ...ok,
        destinationDomain: 5,
        recipient: { encoding: "base58", tokenAccount: "not-base58!", owner: OWNER },
      }),
    ).toThrow();
    expect(() => buildHyperliquidWithdrawal({ ...ok, amount: 0n })).toThrow();
    expect(() => buildHyperliquidWithdrawal({ ...ok, nonce: 1.5 })).toThrow();
    expect(() => buildHyperliquidWithdrawal({ ...ok, signatureChainId: 0 })).toThrow();
  });
});

describe("solanaForwardData", () => {
  it("is Circle's 24-byte magic, the open-account flag 01, then the owner's 32 bytes", () => {
    expect(solanaForwardData(OWNER)).toBe(PY.solanaData);
    expect((solanaForwardData(OWNER).length - 2) / 2).toBe(24 + 1 + 32);
  });
});

describe("buildHyperliquidFee", () => {
  it("is a perps usdSend of Xebra's fee, the nonce after the withdrawal's", async () => {
    const tx = buildHyperliquidFee({
      feeAddress: FEE_ADDRESS,
      amount: 11_000n,
      balance: "perps",
      nonce: NONCE + 1,
      signatureChainId: 42161,
    });
    expect(tx.action).toEqual({
      type: "usdSend",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      destination: "0x32e95718a4d9b60f2e4fb1d371189ac5dd28211a",
      amount: "0.011",
      time: NONCE + 1,
    });
    expect(tx.nonce).toBe(NONCE + 1);
    expect(hashTypedData(JSON.parse(JSON.stringify(tx.typedData)))).toBe(PY.usdSend.digest);
    expect(await sign(tx)).toBe(PY.usdSend.signature);
  });

  it("is a spotSend of USDC when the withdrawal comes from the spot balance", async () => {
    const tx = buildHyperliquidFee({
      feeAddress: FEE_ADDRESS,
      amount: 12_450n,
      balance: "spot",
      nonce: NONCE + 1,
      signatureChainId: 8453,
    });
    expect(tx.action).toEqual({
      type: "spotSend",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x2105",
      destination: "0x32e95718a4d9b60f2e4fb1d371189ac5dd28211a",
      token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
      amount: "0.01245",
      time: NONCE + 1,
    });
    expect(hashTypedData(JSON.parse(JSON.stringify(tx.typedData)))).toBe(PY.spotSend.digest);
    expect(await sign(tx)).toBe(PY.spotSend.signature);
  });

  it("reproduces Hyperliquid's own usdSend test vector (testnet, signatureChainId 0x66eee)", async () => {
    const tx = buildHyperliquidFee({
      feeAddress: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
      amount: 1_000_000n,
      balance: "perps",
      nonce: 1687816341423,
      signatureChainId: 0x66eee,
      network: "Testnet",
    });
    const sig = await sign(
      tx,
      "0x0123456789012345678901234567890123456789012345678901234567890123",
    );
    const body = hyperliquidExchangeBody(tx, sig);
    expect(body.signature).toEqual({
      r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      v: 27,
    });
  });

  it("refuses a zero fee or a bad fee address", () => {
    const ok = {
      feeAddress: FEE_ADDRESS,
      amount: 10_000n,
      balance: "perps" as const,
      nonce: NONCE + 1,
      signatureChainId: 42161,
    };
    expect(() => buildHyperliquidFee({ ...ok, amount: 0n })).toThrow();
    expect(() => buildHyperliquidFee({ ...ok, feeAddress: "0xnope" })).toThrow();
  });
});

describe("hyperliquidExchangeBody", () => {
  it("is what /exchange takes: the action, its nonce, and the signature split into r, s and v", async () => {
    const tx = arcPerps();
    const sig = await sign(tx);
    const body = hyperliquidExchangeBody(tx, sig);
    expect(body.action).toEqual(tx.action);
    expect(body.nonce).toBe(NONCE);
    expect(body.signature.r).toBe(`0x${sig.slice(2, 66)}`);
    expect(body.signature.s).toBe(`0x${sig.slice(66, 130)}`);
    expect(body.signature.v).toBe(27);
    const signer = await recoverTypedDataAddress({
      ...JSON.parse(JSON.stringify(tx.typedData)),
      signature: sig,
    });
    expect(signer).toBe(SIGNER);
  });

  it("turns a 0/1 recovery id into 27/28 and refuses a signature that is not 65 bytes", async () => {
    const tx = arcPerps();
    const sig = await sign(tx);
    const v0 = `${sig.slice(0, 130)}00` as `0x${string}`;
    expect(hyperliquidExchangeBody(tx, v0).signature.v).toBe(27);
    const v1 = `${sig.slice(0, 130)}01` as `0x${string}`;
    expect(hyperliquidExchangeBody(tx, v1).signature.v).toBe(28);
    expect(() => hyperliquidExchangeBody(tx, "0x1234")).toThrow();
    expect(() => hyperliquidExchangeBody(tx, `${sig.slice(0, 130)}1d` as `0x${string}`)).toThrow();
  });
});
