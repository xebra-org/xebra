/**
 * @xebra/cctp-solana — CCTP V2 on Solana: `receiveMessage` (the mint) and
 * `depositForBurnWithHook` (the burn).
 *
 * Used by `/claim`, where a user completes their own mint when a forward did not land, and by the
 * routes that build a burn for a transfer starting on Solana. Nothing here signs or sends on our
 * behalf beyond a one-time event-account key: the account lists were verified against mainnet, and
 * the page hands the transaction to the user's wallet.
 *
 * Kept out of @xebra/cctp-client on purpose: that package has no chain dependencies.
 */

export * from "./deposit-for-burn.js";
export * from "./receive-message.js";
