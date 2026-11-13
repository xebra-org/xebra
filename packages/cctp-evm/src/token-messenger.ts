import { type Hex, encodeFunctionData, getAddress, isAddress, parseAbi } from "viem";

/**
 * CCTP V2 `TokenMessengerV2.depositForBurnWithHook`, the one call that starts a transfer from an
 * EVM chain.
 *
 * On these routes the browser calls Circle directly, with no Xebra contract in between. The
 * Soroban wrapper fixes three things on the Stellar route and nothing does that here, so this
 * encoder fixes them instead and takes no argument for any of them:
 *
 *   - **the hook** is `FORWARD_HOOK`, which asks Circle's Forwarding Service to deliver the mint,
 *     or for a Solana recipient with no USDC account yet the 65-byte form that also opens one.
 *     Both are built here from a validated owner; a caller cannot pass hook bytes of its own;
 *   - **`destinationCaller`** is zero, so anyone may submit the mint. Circle's forwarder requires
 *     it, and it is what keeps a failed delivery claimable by its owner at `/claim`;
 *   - **`minFinalityThreshold`** is one of Circle's two speeds, never a number in between.
 *
 * The signature is not in Circle's published ABI package we depend on; its selector, `0x779b432d`,
 * is checked against the live implementation bytecode on every chain by
 * `scripts/check-evm-cctp.sh`.
 */
export const tokenMessengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/**
 * `"cctp-forward"` right-padded to 32 bytes: magic (24), version 0 (4), payload length 0 (4).
 *
 * The same bytes as `FORWARD_HOOK` in `contracts/stellar-cctp-wrapper-v2/src/lib.rs`, which are
 * the bytes mainnet has accepted on every forwarded transfer so far.
 */
export const FORWARD_HOOK: Hex =
  "0x636374702d666f72776172640000000000000000000000000000000000000000";

export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/** Solana's CCTP domain: the one destination here whose recipient is not an EVM address. */
export const SOLANA_DOMAIN = 5;
export const STELLAR_DOMAIN = 27;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The forwarding hook that also asks Circle to open the recipient's USDC account on Solana, 65
 * bytes: the same 24-byte magic, version 0, payload length 33, the ATA-creation flag `01`, then
 * the 32-byte wallet that will own the account.
 *
 * Byte for byte what `forward_hook_with_account` in `contracts/stellar-cctp-wrapper-v2` builds and
 * what mainnet accepted (burn `7dcf762a…ada79`); a test pins it to those bytes.
 */
export function forwardHookWithAccount(owner: Hex): Hex {
  if (!BYTES32.test(owner) || owner === ZERO_BYTES32) {
    throw new Error("the account owner must be a non-zero 32-byte Solana public key");
  }
  const magic = FORWARD_HOOK.slice(2, 2 + 48);
  const version = "00000000";
  const length = (33).toString(16).padStart(8, "0");
  return `0x${magic}${version}${length}01${owner.slice(2).toLowerCase()}`;
}

/**
 * Who the mint goes to. An EVM address as a string, or for Solana the USDC *token account* (never
 * the wallet: Circle mints into the account named, and a wallet address there strands the
 * transfer) plus, when that account does not exist yet, the wallet Circle should open it for.
 */
export type BurnRecipient =
  | string
  | { kind: "solana"; tokenAccount: Hex; createAccountFor?: Hex | undefined }
  /**
   * Stellar: Circle's `CctpForwarder` contract (32 bytes) receives the mint and pays the account
   * named in `hookData`. Circle's Forwarding Service does not deliver to Stellar, so someone must
   * call the forwarder's `mint_and_forward`; Xebra's relayer does, and anyone else may.
   */
  | { kind: "stellar"; forwarder: Hex; hookData: Hex };

/** Circle's two speeds, as the finality a burn asks for. */
export const FINALITY = { fast: 1000, standard: 2000 } as const;
export type Finality = (typeof FINALITY)[keyof typeof FINALITY];

/** An EVM address as CCTP carries it: left-padded to 32 bytes. */
export function addressToBytes32(address: string): Hex {
  if (!isAddress(address, { strict: false })) throw new Error(`not an EVM address: ${address}`);
  return `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;
}

export interface BurnWithHookArgs {
  /** USDC to burn, in the token's 6-decimal units. */
  amount: bigint;
  destinationDomain: number;
  /** The recipient on the destination chain. */
  recipient: BurnRecipient;
  /** The USDC contract on the source chain. */
  burnToken: string;
  /** What Circle may keep, delivery and speed together. Circle keeps all of it. */
  maxFee: bigint;
  minFinalityThreshold: Finality;
}

export function encodeDepositForBurnWithHook(args: BurnWithHookArgs): Hex {
  if (args.amount <= 0n) throw new Error("amount must be positive");
  // Circle's contract reverts unless the fee is strictly less than the amount; saying so here
  // means a wallet is never asked to sign a transaction that cannot succeed.
  if (args.maxFee < 0n || args.maxFee >= args.amount) {
    throw new Error("maxFee must be less than the amount");
  }
  if (args.minFinalityThreshold !== 1000 && args.minFinalityThreshold !== 2000) {
    throw new Error("minFinalityThreshold must be 1000 (Fast) or 2000 (Standard)");
  }
  const { mintRecipient, hookData, destinationCaller } = recipientAndHook(
    args.recipient,
    args.destinationDomain,
  );
  if (!isAddress(args.burnToken, { strict: false })) {
    throw new Error(`not an EVM address: ${args.burnToken}`);
  }
  return encodeFunctionData({
    abi: tokenMessengerAbi,
    functionName: "depositForBurnWithHook",
    args: [
      args.amount,
      args.destinationDomain,
      mintRecipient,
      getAddress(args.burnToken),
      destinationCaller,
      args.maxFee,
      args.minFinalityThreshold,
      hookData,
    ],
  });
}

/**
 * The 32-byte recipient a burn names and the hook that goes with it, after every check above.
 * Exported for the Xebra wrapper's encoder, which sends the same recipient and the owner, and lets
 * the contract build the hook.
 */
export function recipientAndHook(
  recipient: BurnRecipient,
  destinationDomain: number,
): { mintRecipient: Hex; hookData: Hex; destinationCaller: Hex } {
  // Stellar first: any other recipient there mints to an address the forwarder never pays, and
  // Circle's docs say such funds are stuck for good.
  if (typeof recipient !== "string" && recipient.kind === "stellar") {
    if (destinationDomain !== STELLAR_DOMAIN) {
      throw new Error("a Stellar recipient can only receive a burn to Stellar");
    }
    const forwarder = recipient.forwarder.toLowerCase() as Hex;
    if (!BYTES32.test(forwarder) || forwarder === ZERO_BYTES32) {
      throw new Error("the Stellar forwarder must be a non-zero 32-byte contract id");
    }
    checkStellarHook(recipient.hookData);
    // The forwarder is also the only caller, as Circle requires: with a zero caller anyone could
    // call receive_message directly, minting into the forwarder without paying the recipient.
    return {
      mintRecipient: forwarder,
      hookData: recipient.hookData.toLowerCase() as Hex,
      destinationCaller: forwarder,
    };
  }
  if (destinationDomain === STELLAR_DOMAIN) {
    throw new Error("a burn to Stellar must go to Circle's forwarder with a Stellar recipient");
  }
  if (typeof recipient === "string") {
    // An EVM address left-padded is a perfectly valid-looking Solana account that nobody owns.
    if (destinationDomain === SOLANA_DOMAIN) {
      throw new Error("a Solana destination needs the recipient's USDC token account");
    }
    const mintRecipient = addressToBytes32(recipient);
    if (mintRecipient === ZERO_BYTES32) throw new Error("the recipient is the zero address");
    return { mintRecipient, hookData: FORWARD_HOOK, destinationCaller: ZERO_BYTES32 };
  }
  if (destinationDomain !== SOLANA_DOMAIN) {
    throw new Error("a Solana token account can only be the recipient of a burn to Solana");
  }
  const tokenAccount = recipient.tokenAccount.toLowerCase() as Hex;
  if (!BYTES32.test(tokenAccount) || tokenAccount === ZERO_BYTES32) {
    throw new Error("the Solana token account must be a non-zero 32-byte key");
  }
  const owner = recipient.createAccountFor?.toLowerCase() as Hex | undefined;
  if (owner === undefined) {
    return { mintRecipient: tokenAccount, hookData: FORWARD_HOOK, destinationCaller: ZERO_BYTES32 };
  }
  // The wrapper's rule: the wallet can never be confused with the token account it owns.
  if (owner === tokenAccount) {
    throw new Error("the account owner and the token account must differ");
  }
  return {
    mintRecipient: tokenAccount,
    hookData: forwardHookWithAccount(owner),
    destinationCaller: ZERO_BYTES32,
  };
}

/**
 * The forwarder's hook: a 32-byte header whose last four bytes are the length of what follows,
 * then a Stellar address as text (G... account or C... contract, 56 characters). The address itself
 * is checked where it is encoded (`@xebra/sdk`); this checks the frame, so a truncated or padded
 * hook never reaches a wallet.
 */
function checkStellarHook(hook: Hex): void {
  if (!/^0x[0-9a-fA-F]*$/.test(hook) || hook.length % 2 !== 0) {
    throw new Error("the Stellar hook is not hex");
  }
  const bytes = Buffer.from(hook.slice(2), "hex");
  if (bytes.length !== 32 + 56)
    throw new Error("the Stellar hook must carry one 56-character address");
  if (bytes.readUInt32BE(28) !== 56) throw new Error("the Stellar hook's length field is wrong");
  const text = bytes.subarray(32).toString("ascii");
  if (!/^[GC][A-Z2-7]{55}$/.test(text))
    throw new Error("the Stellar hook does not name an address");
}
