import { type Hex, encodeFunctionData, getAddress, parseAbi } from "viem";
import { CctpEvmError } from "./errors.js";

/**
 * The three ERC-20 calls a burn needs: what the sender holds, what Circle's messenger may already
 * pull, and permission to pull this transfer's amount.
 */
export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export function encodeBalanceOf(owner: string): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(owner)],
  });
}

export function encodeAllowance(owner: string, spender: string): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [getAddress(owner), getAddress(spender)],
  });
}

/**
 * Approval for exactly `amount`. Never unlimited: an allowance outlives the transfer it was given
 * for, and one sized to the transfer is spent by it.
 */
export function encodeApprove(spender: string, amount: bigint): Hex {
  if (amount <= 0n) throw new CctpEvmError("invalid_amount", "amount must be positive");
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [getAddress(spender), amount],
  });
}

/**
 * A `uint256` out of an `eth_call` result.
 *
 * An empty result (`0x`) is what a node returns for a call to an address with no code, which on
 * the wrong chain is exactly what a token address is. It is refused, not read as zero: "you hold
 * nothing" and "we asked the wrong chain" must never look the same.
 */
export function decodeUint256(result: unknown): bigint {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new CctpEvmError("invalid_request", "the chain returned no value for a token read");
  }
  return BigInt(result);
}
