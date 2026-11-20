import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { formatUsdc6 } from "../core/amounts.js";
import { SUI_CCTP_IDS as CFG, DENY_LIST_ID } from "./sui.js";
import type { TransferStep } from "./types.js";

/**
 * The Sui side of a transfer *into* Sui: Circle's CCTP V2 mint, submitted by whoever holds the
 * attested `(message, attestation)` pair.
 *
 * Circle's Forwarding Service does not deliver to Sui (Iris refuses a forward quote to domain 8 from
 * every source), so a burn to Sui is minted by a person: the recipient, or anyone paying the gas for
 * them. The USDC always goes to the burn's `mintRecipient`, never to the signer, so a stranger who
 * submits it can only pay for someone else's delivery.
 *
 * The four calls, in this order, are what Circle's own mints on mainnet run (transactions
 * C6C7hezpxmCKGLwyk6kbC6mCFnmusZjfJcYn1dTVpnbS and Ce5NanGjotGBpacMFzBVfgy6rvMvAHqYxLsPuPdPt74f,
 * read 2026-11-20), with the function signatures read from the packages on chain:
 *
 *   1. `message_transmitter::receive_message::receive_message(message, attestation, &mut MT state)`
 *      checks Circle's signatures and the nonce, and returns a `Receipt`.
 *   2. `token_messenger_minter::handle_receive_message::prepare_mint<USDC>(receipt, &TMM state, clock)`
 *   3. `stablecoin_handler::handler::mint(&handler state, mint_receipt, &TMM state, &mut treasury,
 *      &deny_list)` mints to the recipient (and the executed fee, if any, to Circle).
 *   4. `token_messenger_minter::handle_receive_message::complete_mint<USDC, handler::Auth>(ticket,
 *      &TMM state, &MT state)`
 *
 * Nothing on the server holds a Sui key: the transaction is built and checked here, and signed in
 * the person's wallet.
 */

/** Sui's CCTP domain. */
const SUI_DOMAIN = 8;
const CLOCK_ID = "0x6";

// CCTP V2 layout (Circle's `MessageV2` and `BurnMessageV2`).
const HEADER_LENGTH = 148;
const BODY_FIXED_LENGTH = 228;

export interface SuiBoundMessage {
  sourceDomain: number;
  /** The Sui address the USDC is minted to. */
  recipient: string;
  /** Who may submit the mint, or null when anyone may (the zero address). */
  destinationCaller: string | null;
  /** What was burned, 6 decimals. */
  amount: bigint;
  /** Circle's fee, taken out of `amount` at the mint (zero for most Standard transfers). */
  feeExecuted: bigint;
  /** What lands with the recipient: `amount - feeExecuted`. */
  received: bigint;
}

function hexOf(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function bytesOf(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Reads a CCTP V2 burn message bound for Sui and refuses anything else. Pure, and free of Node's
 * `Buffer`, so the claim page can run it as is.
 */
export function readSuiBoundMessage(message: Uint8Array): SuiBoundMessage {
  if (message.length < HEADER_LENGTH + BODY_FIXED_LENGTH) throw new Error("message is too short");
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  if (view.getUint32(0) !== 1) throw new Error("not a CCTP V2 message");
  if (view.getUint32(HEADER_LENGTH) !== 1) throw new Error("not a CCTP V2 burn message");
  const destinationDomain = view.getUint32(8);
  if (destinationDomain !== SUI_DOMAIN) {
    throw new Error(`this transfer is bound for CCTP domain ${destinationDomain}, not Sui`);
  }
  const caller = message.subarray(108, 140);
  const body = message.subarray(HEADER_LENGTH);
  const amount = BigInt(hexOf(body.subarray(68, 100)));
  const feeExecuted = BigInt(hexOf(body.subarray(164, 196)));
  return {
    sourceDomain: view.getUint32(4),
    recipient: hexOf(body.subarray(36, 68)),
    destinationCaller: caller.every((b) => b === 0) ? null : hexOf(caller),
    amount,
    feeExecuted,
    received: amount - feeExecuted,
  };
}

export interface SuiMintArgs {
  /** The wallet that signs and pays the gas. Not necessarily the recipient. */
  sender: string;
  /** Circle's message, hex. */
  message: string;
  /** Circle's attestation, hex. */
  attestation: string;
}

function one<T>(r: readonly T[]): [T] {
  if (r[0] === undefined) throw new Error("missing Move call result");
  return [r[0]];
}

/**
 * The mint's four Move calls, unresolved: no node is asked anything. Split out so a test can read
 * the exact calls and arguments (`tx.getData()`).
 *
 * @internal
 */
export function mintMoveCalls(p: SuiMintArgs): Transaction {
  const tx = new Transaction();
  tx.setSender(p.sender);
  const [receipt] = one(
    tx.moveCall({
      target: `${CFG.mtV2PackageId}::receive_message::receive_message`,
      arguments: [
        tx.pure.vector("u8", Array.from(bytesOf(p.message))),
        tx.pure.vector("u8", Array.from(bytesOf(p.attestation))),
        tx.object(CFG.mtV2StateId),
      ],
    }),
  );
  const [mintReceipt] = one(
    tx.moveCall({
      target: `${CFG.tmmV2PackageId}::handle_receive_message::prepare_mint`,
      arguments: [receipt, tx.object(CFG.tmmV2StateId), tx.object(CLOCK_ID)],
      typeArguments: [CFG.usdcType],
    }),
  );
  const [ticket] = one(
    tx.moveCall({
      target: `${CFG.handlerPackageId}::handler::mint`,
      arguments: [
        tx.object(CFG.handlerStateId),
        mintReceipt,
        tx.object(CFG.tmmV2StateId),
        tx.object(CFG.treasuryId),
        tx.object(DENY_LIST_ID),
      ],
    }),
  );
  tx.moveCall({
    target: `${CFG.tmmV2PackageId}::handle_receive_message::complete_mint`,
    arguments: [ticket, tx.object(CFG.tmmV2StateId), tx.object(CFG.mtV2StateId)],
    typeArguments: [CFG.usdcType, `${CFG.handlerPackageId}::handler::Auth`],
  });
  return tx;
}

/** The burn's nonce has already been used: the USDC is on Sui and there is nothing to claim. */
export class AlreadyMintedError extends Error {
  constructor() {
    super("This transfer has already been minted on Sui.");
  }
}

/** The burn named a `destinationCaller`, and it is not the connected wallet. */
export class WrongSuiCallerError extends Error {
  constructor(readonly caller: string) {
    super(`Only ${caller} may submit this transfer's mint on Sui; connect that wallet.`);
  }
}

/** Circle has paused CCTP on Sui; the mint will go through once it resumes. */
export class SuiCctpPausedError extends Error {
  constructor() {
    super("Circle has paused CCTP on Sui for now. The transfer is safe; try again later.");
  }
}

/**
 * The abort code from a failed simulation when `message_transmitter::receive_message` raised it, or
 * null for any other failure. Codes from Circle's `receive_message.move`: 0 `EPaused`,
 * 1 `EInvalidDestinationCaller`, 2 `EInvalidDestinationDomain`, 4 `ENonceAlreadyUsed` (seen on
 * mainnet 2026-11-20 for an already-minted message, in both shapes below).
 *
 * @internal
 */
export function receiveAbortCode(error: string): number | null {
  // Two shapes seen from mainnet nodes, both carrying the location and the code:
  //   "MoveAbort in 1st command, abort code: 4, in '0x16bc…::receive_message::receive_message_shared'"
  //   "Move Runtime Abort. Location: 16bc…::receive_message::receive_message_shared (…) at offset 83,
  //    Abort Code: 4 in command 0"
  const text = decodeURIComponent(error.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
  const location = /(?:0x)?([0-9a-f]{64})::receive_message::/i.exec(text);
  const code = /abort code:\s*(\d+)/i.exec(text);
  if (!location || !code) return null;
  if (`0x${location[1]?.toLowerCase()}` !== CFG.mtV2PackageId) return null;
  return Number(code[1]);
}

/**
 * Builds the mint for the wallet to sign, after checking that the message is bound for Sui, that
 * this wallet may submit it, and that it would succeed now. A transfer someone already minted is
 * reported as `AlreadyMintedError`, never handed to the wallet to fail there.
 */
export async function buildSuiMint(
  client: SuiGrpcClient,
  p: SuiMintArgs,
): Promise<{ transaction: string; message: SuiBoundMessage }> {
  const message = readSuiBoundMessage(bytesOf(p.message));
  if (message.destinationCaller && message.destinationCaller !== p.sender.toLowerCase()) {
    throw new WrongSuiCallerError(message.destinationCaller);
  }
  const tx = mintMoveCalls(p);
  // Resolved against the node, so the wallet gets object versions and a gas budget. The build runs
  // the transaction once without executing it; an abort comes back as the error.
  try {
    await tx.build({ client });
  } catch (err) {
    const code = receiveAbortCode(err instanceof Error ? err.message : String(err));
    if (code === 4) throw new AlreadyMintedError();
    if (code === 0) throw new SuiCctpPausedError();
    throw err;
  }
  return { transaction: await tx.toJSON({ client }), message };
}

/** `buildSuiMint` as the step a wallet signs. */
export async function buildSuiMintStep(
  client: SuiGrpcClient,
  p: SuiMintArgs,
): Promise<TransferStep> {
  const { transaction, message } = await buildSuiMint(client, p);
  return {
    id: "claim",
    chain: "sui",
    description: `Mint ${formatUsdc6(message.received)} USDC on Sui to ${message.recipient}; the signer pays the gas.`,
    tx: { kind: "sui", json: transaction },
    expiresAt: null,
  };
}
