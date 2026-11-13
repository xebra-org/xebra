import { PublicKey } from "@solana/web3.js";
import { StrKey } from "@stellar/stellar-sdk";
import { FORWARD_HOOK } from "@xebra/cctp-evm";
import { buildDepositForBurnWithHookInstruction } from "@xebra/cctp-solana";
import { EVM_CHAINS, STELLAR_CCTP_FORWARDER, parseMessage, verifyMessage } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import { parseSolanaSendsTo } from "./config";
import { solanaBurnParams, stellarForwarderBytes } from "./plan";

/**
 * A burn to Stellar with the wrong bytes is USDC nobody can ever mint: Circle attests it, and the
 * forwarder either cannot be called for it or pays nobody. So the bytes are checked against REAL
 * mainnet Solana to Stellar burns (read over RPC on 2026-11-13), not against our own encoder.
 */
const STELLAR_BURNS = [
  {
    // 2bDXTMyLLYac1jMjqxZSqkpkCvypk54TqGGzCQYQVRBUWKWGDDeuGbs1pCq4QnWCgkL2mh34678XKQ98fB48Z1UM
    owner: "7GdPAYzsV6fcxDVUZENRmQMwJ23B8GAywWZMDnYozjr4",
    eventRentPayer: "5aDssL53qFByo7SKRSKiLcPepdbabmCunttZ1Crm8VH2",
    burnTokenAccount: "F6T8px6b5LeZpuPbkzdSACmzLSkRmVKrcSUJB7Sosiy7",
    event: "JBQzrPoKv2CjnAkf2wiJpLBapqGX5VPpccm5jxNF3KwY",
    recipient: "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV",
    amount: 974_600_000n,
    data: "6ff53e83cc6cdf9b4037173a000000001b00000072bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf29172bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf2910000000000000000d00700005800000000000000000000000000000000000000000000000000000000000000000000384742484333553652555555354e52583753485a325843354841354a49473336344c4f4d564a4c59574d37324a4642414e575357594a375a56",
  },
  {
    // 3aa4tEraY6tBLmWxUya9hPbP5CFjcFmTe8QgfNNrXD11exiJ27u1EcLtuVgjSwgi9v6fTV1QoNmFPxzn23HHCVLB
    recipient: "GB44W23OXZC2EQBM4E3XM7DLFYM6AV66CUOA2FXDBNZ6IZ2T4EZERZIH",
    amount: 2_500_000_000n,
    data: "6ff53e83cc6cdf9b00f90295000000001b00000072bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf29172bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf2910000000000000000d0070000580000000000000000000000000000000000000000000000000000000000000000000038474234345732334f585a43324551424d344533584d37444c46594d364156363643554f4132465844424e5a36495a325434455a45525a4948",
  },
] as const;

/** Circle's attested message for the first burn above, from Iris (`/v2/messages/5?transactionHash=`). */
const ATTESTED_STELLAR_MESSAGE =
  "0x00000001000000050000001b7e86905b7ac5bd79522c34151dc0b7d69a72e7718ba33d6ea0b11e3987d9cca5a65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e9389309a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded272bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291000007d0000007d000000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6172bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291000000000000000000000000000000000000000000000000000000003a1737405d26f89b74feeb7a5cc13a9c0a7cd8d2ecbf5999eb2f577d74d3faefdcce6c6d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000384742484333553652555555354e52583753485a325843354841354a49473336344c4f4d564a4c59574d37324a4642414e575357594a375a56";

/** Stellar mainnet's CCTP TokenMessenger, as `.env.production` names it. */
const STELLAR_TOKEN_MESSENGER = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("a Solana burn to Stellar", () => {
  it.each(STELLAR_BURNS)("carries exactly what a real attested burn carried ($amount)", (burn) => {
    const params = solanaBurnParams(
      { kind: "stellar", recipient: burn.recipient },
      burn.amount,
      0n,
    );
    const ix = buildDepositForBurnWithHookInstruction(
      {
        owner: PublicKey.default,
        messageSentEventData: PublicKey.default,
      },
      params,
    );
    expect(ix.data.toString("hex")).toBe(burn.data);
  });

  it("names Circle's forwarder as both the mint recipient and the only caller", () => {
    const p = solanaBurnParams(
      { kind: "stellar", recipient: STELLAR_BURNS[0].recipient },
      5_000_000n,
      0n,
    );
    const forwarder = hex(StrKey.decodeContract(STELLAR_CCTP_FORWARDER));
    expect(forwarder).toBe("72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291");
    expect(hex(p.mintRecipient)).toBe(forwarder);
    expect(hex(p.destinationCaller)).toBe(forwarder);
    expect(hex(stellarForwarderBytes())).toBe(forwarder);
    expect(p.destinationDomain).toBe(27);
    expect(p.maxFee).toBe(0n);
    expect(p.minFinalityThreshold).toBe(2000);
    // 32-byte header (version 0, length 56), then the G... account as text.
    const hook = Buffer.from(p.hookData);
    expect(hook.subarray(0, 28).every((b) => b === 0)).toBe(true);
    expect(hook.readUInt32BE(28)).toBe(56);
    expect(hook.subarray(32).toString("utf8")).toBe(STELLAR_BURNS[0].recipient);
  });

  it("is a message the relayer accepts from Solana, and pays the account in the hook", () => {
    const message = Buffer.from(ATTESTED_STELLAR_MESSAGE.slice(2), "hex");
    const burn = verifyMessage(message, {
      tokenMessenger: STELLAR_TOKEN_MESSENGER,
      sources: [5],
    });
    expect(burn).toEqual({
      amount: 974_600_000n,
      recipient: STELLAR_BURNS[0].recipient,
      sourceDomain: 5,
    });
    // And it is exactly what our parameters ask Circle to carry.
    const p = solanaBurnParams(
      { kind: "stellar", recipient: STELLAR_BURNS[0].recipient },
      974_600_000n,
      0n,
    );
    const parsed = parseMessage(message);
    expect(hex(parsed.mintRecipient)).toBe(hex(p.mintRecipient));
    expect(hex(parsed.destinationCaller)).toBe(hex(p.destinationCaller));
    expect(hex(parsed.hookData)).toBe(hex(p.hookData));
    // Solana's remote token messenger for domain 27 is the one our relayer checks against.
    expect(hex(parsed.destinationTokenMessenger)).toBe(
      hex(StrKey.decodeContract(STELLAR_TOKEN_MESSENGER)),
    );
  });

  it("is refused by the Sui-only check, so the relayer must list Solana to complete it", () => {
    const message = Buffer.from(ATTESTED_STELLAR_MESSAGE.slice(2), "hex");
    expect(() => verifyMessage(message, { tokenMessenger: STELLAR_TOKEN_MESSENGER })).toThrow(
      "not a burn from Sui",
    );
  });

  it("refuses anything but a G... account, and any fee", () => {
    const contract = STELLAR_CCTP_FORWARDER;
    expect(() =>
      solanaBurnParams({ kind: "stellar", recipient: contract }, 5_000_000n, 0n),
    ).toThrow(/starting with G/);
    expect(() => solanaBurnParams({ kind: "stellar", recipient: "GABC" }, 5_000_000n, 0n)).toThrow(
      /starting with G/,
    );
    expect(() =>
      solanaBurnParams({ kind: "stellar", recipient: STELLAR_BURNS[0].recipient }, 5_000_000n, 1n),
    ).toThrow(/no fee/);
  });
});

describe("a Solana burn to an EVM chain", () => {
  const recipient = "0x1111111111111111111111111111111111111111";

  it("carries exactly what a real burn Circle forwarded to Base carried", () => {
    // 3uY8BdRmijxsnuAqxx5sy12qLBf1QvdoxxJdJgDaveyiHHEMDAwbjBimteY49piuvBoTYhmXu3hELvcyp6AjCSX6:
    // 200.8 USDC to Base, maxFee 54,561, zero caller, the plain cctp-forward hook. Iris reports
    // forwardState COMPLETE and Circle kept exactly the maxFee (feeExecuted 54,561).
    const p = solanaBurnParams(
      {
        kind: "evm",
        chain: EVM_CHAINS.base,
        recipient: "0x140d18eaa68c34c3ca761988f83cf8c395526e1d",
      },
      200_800_000n,
      54_561n,
    );
    const ix = buildDepositForBurnWithHookInstruction(
      { owner: PublicKey.default, messageSentEventData: PublicKey.default },
      p,
    );
    expect(ix.data.toString("hex")).toBe(
      "6ff53e83cc6cdf9b00f7f70b0000000006000000000000000000000000000000140d18eaa68c34c3ca761988f83cf8c395526e1d000000000000000000000000000000000000000000000000000000000000000021d5000000000000d007000020000000636374702d666f72776172640000000000000000000000000000000000000000",
    );
  });

  it.each(Object.values(EVM_CHAINS))("asks Circle to forward to $name", (chain) => {
    const p = solanaBurnParams({ kind: "evm", chain, recipient }, 5_000_000n, 60_000n);
    expect(p.destinationDomain).toBe(chain.cctpDomainId);
    expect(hex(p.mintRecipient)).toBe(`${"00".repeat(12)}${"11".repeat(20)}`);
    // Zero: Circle's forwarder requires it, and a failed delivery stays claimable by anyone.
    expect(hex(p.destinationCaller)).toBe("00".repeat(32));
    expect(`0x${hex(p.hookData)}`).toBe(FORWARD_HOOK);
    expect(p.maxFee).toBe(60_000n);
    expect(p.minFinalityThreshold).toBe(2000);
  });

  it("refuses a bad address and a burn with no delivery fee", () => {
    const chain = EVM_CHAINS.base;
    expect(() =>
      solanaBurnParams({ kind: "evm", chain, recipient: "0x12" }, 5_000_000n, 1n),
    ).toThrow();
    expect(() => solanaBurnParams({ kind: "evm", chain, recipient }, 5_000_000n, 0n)).toThrow(
      /maxFee/,
    );
    expect(() =>
      solanaBurnParams({ kind: "evm", chain, recipient }, 5_000_000n, 5_000_000n),
    ).toThrow(/maxFee/);
  });
});

describe("SOLANA_SENDS_TO", () => {
  it("is off when unset, empty or none", () => {
    for (const raw of [undefined, "", " ", "none"]) {
      expect(parseSolanaSendsTo(raw)).toEqual({ evm: [], stellar: false });
    }
  });
  it("names chains, ignores unknown ones, and keeps table order", () => {
    const s = parseSolanaSendsTo(" Arc, base ,solana,ethereum ");
    expect(s.evm.map((c) => c.id)).toEqual(["base", "arc"]);
    expect(s.stellar).toBe(false);
  });
  it("`all` is every EVM chain in the table; Stellar only by name", () => {
    expect(parseSolanaSendsTo("all").evm).toHaveLength(Object.keys(EVM_CHAINS).length);
    expect(parseSolanaSendsTo("all").stellar).toBe(false);
    expect(parseSolanaSendsTo("all,stellar").stellar).toBe(true);
    expect(parseSolanaSendsTo("stellar")).toEqual({ evm: [], stellar: true });
  });
});
