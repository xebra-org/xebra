import { FINALITY, tokenMessengerAbi, xebraWrapperAbi } from "@xebra/cctp-evm";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { decodeFunctionData } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARC_GAS_RESERVE_UNITS,
  type EvmBridgeRequest,
  type EvmBridgeStep,
  getUsdcBalance6,
  spendableUsdc,
  submitEvmBridge,
} from "./evm-bridge";

const { base, arc } = EVM_CHAINS;
const FROM = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const APPROVAL_HASH = `0x${"a1".repeat(32)}`;
const BURN_HASH = `0x${"b2".repeat(32)}`;

/** The latest block's timestamp in this scripted chain. */
const CHAIN_NOW = 1_800_000_000n;
const WRAPPER = "0x3333333333333333333333333333333333333333";

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Call = { method: string; params?: unknown[] };

/**
 * A wallet with just enough chain behind it: a network, a balance, an allowance that an approval
 * sets, and a record of everything it was asked.
 */
function chain(
  over: Partial<{
    chainId: number;
    balance: bigint;
    allowance: bigint;
    /** What an approval actually sets, when the user lowers it in the wallet. */
    approvalSets: bigint;
    approvalStatus: string;
    /** The network the wallet is on once the approval has confirmed. */
    chainAfterApproval: number;
    simulation: () => string;
    emptyReads: boolean;
  }> = {},
) {
  const state = {
    chainId: base.chainId,
    balance: 100_000_000n,
    allowance: 0n,
    approvalStatus: "0x1",
    simulation: () => "0x",
    ...over,
  };
  const calls: Call[] = [];
  const sent: Array<{ to: string; data: string; chainId?: string }> = [];
  const provider = {
    request: async (call: Call) => {
      calls.push(call);
      const [arg] = (call.params ?? []) as [Record<string, string>];
      switch (call.method) {
        case "eth_chainId":
          return `0x${state.chainId.toString(16)}`;
        case "wallet_switchEthereumChain":
          return null;
        case "eth_call": {
          if (state.emptyReads) return "0x";
          const selector = arg?.data?.slice(0, 10);
          if (selector === "0x70a08231") return word(state.balance);
          if (selector === "0xdd62ed3e") return word(state.allowance);
          if (selector === "0x779b432d" || selector === "0x132519fe") return state.simulation();
          throw new Error(`unexpected eth_call ${selector}`);
        }
        case "eth_sendTransaction": {
          sent.push(arg as never);
          if (arg?.data?.startsWith("0x095ea7b3")) {
            state.allowance = state.approvalSets ?? BigInt(`0x${arg.data.slice(-64)}`);
            if (state.chainAfterApproval) state.chainId = state.chainAfterApproval;
            return APPROVAL_HASH;
          }
          return BURN_HASH;
        }
        case "eth_getTransactionReceipt":
          return { status: state.approvalStatus };
        case "eth_getBlockByNumber":
          return { timestamp: `0x${CHAIN_NOW.toString(16)}` };
        default:
          throw new Error(`unexpected ${call.method}`);
      }
    },
  };
  return { provider, calls, sent, state };
}

const request = (c: ReturnType<typeof chain>, over: Partial<EvmBridgeRequest> = {}) => ({
  provider: c.provider,
  from: FROM,
  source: base,
  destination: arc,
  recipient: RECIPIENT,
  amount: 5_000_000n,
  maxFee: 16_778n,
  finality: FINALITY.standard,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("submitEvmBridge through Xebra's wrapper", () => {
  it("approves the wrapper, not Circle, and calls its bridge with a deadline from the chain", async () => {
    const c = chain({ chainId: arc.chainId });
    const result = await submitEvmBridge(
      request(c, {
        source: arc,
        destination: base,
        maxFee: 54_099n,
        via: { address: WRAPPER, maxWrapperFee: 300_000n },
      }),
    );
    expect(result).toEqual({ txHash: BURN_HASH, approvalTxHash: APPROVAL_HASH });

    const [approval, burn] = c.sent;
    expect(approval?.to).toBe(arc.usdcAddress);
    expect(approval?.data).toContain(WRAPPER.slice(2));
    expect(approval?.data).not.toContain(arc.tokenMessengerAddress.slice(2).toLowerCase());
    expect(burn?.to).toBe(WRAPPER);

    const { functionName, args } = decodeFunctionData({
      abi: xebraWrapperAbi,
      data: burn?.data as `0x${string}`,
    });
    expect(functionName).toBe("bridge");
    const [req] = args as unknown as [Record<string, unknown>];
    expect(req.amount).toBe(5_000_000n);
    expect(req.destinationDomain).toBe(base.cctpDomainId);
    expect(req.maxFee).toBe(54_099n);
    expect(req.maxWrapperFee).toBe(300_000n);
    // Ten minutes from the chain's own clock, not the computer's.
    expect(req.deadline).toBe(CHAIN_NOW + 600n);
  });

  it("simulates the wrapper's bridge before asking for the burn", async () => {
    const c = chain({
      chainId: arc.chainId,
      allowance: 5_000_000n,
      simulation: () => {
        throw new Error("execution reverted: WrapperFeeAboveUserCap()");
      },
    });
    await expect(
      submitEvmBridge(
        request(c, {
          source: arc,
          destination: base,
          via: { address: WRAPPER, maxWrapperFee: 300_000n },
        }),
      ),
    ).rejects.toThrow(/WrapperFeeAboveUserCap[\s\S]*Nothing was burned/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("submitEvmBridge", () => {
  it("approves the exact amount to Circle's messenger, then burns to it", async () => {
    const c = chain();
    const steps: EvmBridgeStep[] = [];
    const result = await submitEvmBridge(request(c, { onStep: (s) => steps.push(s) }));

    expect(result).toEqual({ txHash: BURN_HASH, approvalTxHash: APPROVAL_HASH });
    expect(steps).toEqual(["switching", "checking", "approving", "confirming-approval", "burning"]);
    expect(c.sent).toHaveLength(2);

    const [approval, burn] = c.sent;
    expect(approval?.to).toBe(base.usdcAddress);
    expect(approval?.data).toContain(base.tokenMessengerAddress.slice(2).toLowerCase());
    expect(BigInt(`0x${approval?.data.slice(-64)}`)).toBe(5_000_000n);
    expect(approval?.chainId).toBe("0x2105");

    expect(burn?.to).toBe(base.tokenMessengerAddress);
    expect(burn?.chainId).toBe("0x2105");
    const decoded = decodeFunctionData({ abi: tokenMessengerAbi, data: burn?.data as never });
    expect(decoded.args.slice(0, 4)).toEqual([
      5_000_000n,
      26,
      `0x${"00".repeat(12)}${RECIPIENT.slice(2)}`,
      base.usdcAddress,
    ]);
    expect(decoded.args[5]).toBe(16_778n);
  });

  it("skips the approval when Circle's messenger may already pull the amount", async () => {
    const c = chain({ allowance: 5_000_000n });
    const result = await submitEvmBridge(request(c));
    expect(result.approvalTxHash).toBeNull();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]?.to).toBe(base.tokenMessengerAddress);
  });

  it("returns the burn hash without waiting for its receipt", async () => {
    const c = chain({ allowance: 5_000_000n });
    await submitEvmBridge(request(c));
    expect(c.calls.filter((x) => x.method === "eth_getTransactionReceipt")).toHaveLength(0);
  });

  it("sends nothing when the wallet will not go to the source chain", async () => {
    const c = chain({ chainId: 1 });
    await expect(submitEvmBridge(request(c))).rejects.toThrow("Your wallet is not on Base");
    expect(c.sent).toHaveLength(0);
    // Not even a read: a balance read on Ethereum would be Ethereum's answer.
    expect(c.calls.filter((x) => x.method === "eth_call")).toHaveLength(0);
  });

  it("refuses before any prompt when the wallet does not hold the amount", async () => {
    const c = chain({ balance: 1_000_000n });
    await expect(submitEvmBridge(request(c))).rejects.toThrow(
      "This wallet holds 1.00 USDC on Base; the transfer needs 5.00.",
    );
    expect(c.sent).toHaveLength(0);
  });

  it("does not read an empty answer as a balance of zero", async () => {
    const c = chain({ emptyReads: true });
    await expect(submitEvmBridge(request(c))).rejects.toThrow("returned no value");
    expect(c.sent).toHaveLength(0);
  });

  it("stops when the approval was lowered in the wallet", async () => {
    const c = chain({ approvalSets: 1_000_000n });
    await expect(submitEvmBridge(request(c))).rejects.toThrow(
      "The approval in your wallet was for less than this transfer. Nothing was burned.",
    );
    expect(c.sent).toHaveLength(1);
  });

  it("stops when the approval reverted", async () => {
    const c = chain({ approvalStatus: "0x0" });
    await expect(submitEvmBridge(request(c))).rejects.toThrow(
      "The approval was reverted on Base. Nothing was burned.",
    );
    expect(c.sent).toHaveLength(1);
  });

  it("stops when the wallet changed network while the approval confirmed", async () => {
    const c = chain({ chainAfterApproval: 1 });
    await expect(submitEvmBridge(request(c))).rejects.toThrow("Your wallet left Base");
    expect(c.sent).toHaveLength(1);
  });

  it("stops before the burn when Circle's fee rose during the approval", async () => {
    const c = chain();
    const currentMaxFee = vi.fn(async () => 20_000n);
    await expect(submitEvmBridge(request(c, { currentMaxFee }))).rejects.toThrow(
      "Circle's fee rose while the approval confirmed (0.016778 to 0.02 USDC). Nothing was burned.",
    );
    expect(c.sent).toHaveLength(1);
  });

  it("carries on when the fee held or fell, and does not ask at all without an approval", async () => {
    const held = vi.fn(async () => 16_778n);
    expect((await submitEvmBridge(request(chain(), { currentMaxFee: held }))).txHash).toBe(
      BURN_HASH,
    );
    const unasked = vi.fn(async () => 99_999_999n);
    const c = chain({ allowance: 5_000_000n });
    await submitEvmBridge(request(c, { currentMaxFee: unasked }));
    expect(unasked).not.toHaveBeenCalled();
  });

  it("does not ask for a signature on a burn the chain says would fail", async () => {
    const c = chain({
      allowance: 5_000_000n,
      simulation: () => {
        throw { code: 3, message: "execution reverted: Blacklistable: account is blacklisted" };
      },
    });
    await expect(submitEvmBridge(request(c))).rejects.toThrow(
      "Base says this transfer would fail: execution reverted: Blacklistable: account is blacklisted. Nothing was burned.",
    );
    expect(c.sent).toHaveLength(0);
  });

  it("simulates the burn as the sender", async () => {
    const c = chain({ allowance: 5_000_000n });
    await submitEvmBridge(request(c));
    const sim = c.calls.find(
      (x) => x.method === "eth_call" && (x.params?.[0] as { from?: string }).from !== undefined,
    );
    expect(sim?.params?.[0]).toMatchObject({ from: FROM, to: base.tokenMessengerAddress });
  });

  it("refuses a fee that is not less than the amount before touching the wallet", async () => {
    const c = chain();
    await expect(submitEvmBridge(request(c, { maxFee: 5_000_000n }))).rejects.toThrow(
      "maxFee must be less than the amount",
    );
    expect(c.calls).toHaveLength(0);
  });
});

describe("sending from Arc to Solana", () => {
  const ATA = `0x${"ab".repeat(32)}` as const;
  const OWNER = `0x${"cd".repeat(32)}` as const;
  const solana = { cctpDomainId: 5, name: "Solana" };
  const onArc = () => chain({ chainId: arc.chainId, balance: 10_000_000n, allowance: 10_000_000n });

  it("mints into the token account and opens it for the owner when asked", async () => {
    const c = onArc();
    await submitEvmBridge(
      request(c, {
        source: arc,
        destination: solana,
        recipient: { kind: "solana", tokenAccount: ATA, createAccountFor: OWNER },
        maxFee: 310_320n,
      }),
    );
    const { args } = decodeFunctionData({
      abi: tokenMessengerAbi,
      data: c.sent[0]?.data as never,
    });
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(ATA);
    // The 65-byte hook: magic, version 0, length 33, flag 01, then the owner.
    expect(args[7]).toBe(
      `0x636374702d666f72776172640000000000000000000000000000000000000021" + "01${OWNER.slice(2)}`.replace(
        '" + "',
        "",
      ),
    );
  });

  it("refuses to send a Solana burn to an EVM address", async () => {
    const c = onArc();
    await expect(
      submitEvmBridge(request(c, { source: arc, destination: solana, maxFee: 151_510n })),
    ).rejects.toThrow("needs the recipient's USDC token account");
    expect(c.calls).toHaveLength(0);
  });
});

describe("sending from Arc, where gas is the same USDC", () => {
  const onArc = (balance: bigint) => chain({ chainId: arc.chainId, balance, allowance: balance });

  it("keeps a gas reserve back from what can be sent", () => {
    expect(spendableUsdc(arc, 1_000_000n)).toBe(1_000_000n - ARC_GAS_RESERVE_UNITS);
    expect(spendableUsdc(arc, 10n)).toBe(0n);
    expect(spendableUsdc(base, 1_000_000n)).toBe(1_000_000n);
  });

  it("refuses a transfer of the whole balance, and says what can be sent", async () => {
    const c = onArc(5_000_000n);
    await expect(
      submitEvmBridge(request(c, { source: arc, destination: base, maxFee: 54_454n })),
    ).rejects.toThrow(
      "Arc pays gas in USDC. Leave 0.05 USDC in the wallet for it and send up to 4.95.",
    );
    expect(c.sent).toHaveLength(0);
  });

  it("allows a transfer that leaves the reserve", async () => {
    const c = onArc(5_050_000n);
    const result = await submitEvmBridge(
      request(c, { source: arc, destination: base, maxFee: 54_454n }),
    );
    expect(result.txHash).toBe(BURN_HASH);
    expect(c.sent[0]?.chainId).toBe("0x13b2");
  });
});

describe("getUsdcBalance6", () => {
  it("reads the source chain's USDC for the owner", async () => {
    const c = chain({ balance: 42_000_000n });
    expect(await getUsdcBalance6(c.provider, base, FROM)).toBe(42_000_000n);
    expect(c.calls[0]?.params?.[0]).toMatchObject({ to: base.usdcAddress });
  });
});
