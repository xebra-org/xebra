/**
 * @xebra/cctp-evm — Circle's CCTP V2 calls on EVM chains, as calldata.
 *
 * `receiveMessage` is used by `/claim`, where a user completes their own mint when a forward did
 * not land. `depositForBurnWithHook` and the ERC-20 calls start a transfer on the routes where the
 * browser calls Circle directly; `bridge` starts one through Xebra's own wrapper where a chain has
 * one. Nothing here signs or sends: every function returns bytes for a
 * wallet to send.
 *
 * Kept out of @xebra/cctp-client for the same reason that package keeps Solana out: it has no
 * chain dependencies.
 */

export * from "./errors.js";
export * from "./receive-message.js";
export * from "./token-messenger.js";
export * from "./erc20.js";
export * from "./xebra-wrapper.js";
