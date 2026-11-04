/**
 * @xebra/chain-adapters — Watch/Fill/Claim adapter interfaces and per-chain implementations,
 * composed by apps/solver per corridor. See docs/architecture.md §7.
 *
 * Implemented: the Solana memo/transfer delivery convention (§4), consumed by the Solana
 * Fill/Claim adapters; the Arc log-decoding logic consumed by apps/indexer-arc, proven against
 * a real anvil-deployed XebraEscrow (see arc/decode.live.test.ts).
 */

export * from "./solana/delivery.js";
export * from "./solana/verify.js";
export * from "./solana/parse.js";
export * from "./arc/decode.js";
export * from "./arc/abi.js";
export * from "./stellar/decode-soroban-events.js";
export * from "./stellar/decode-horizon-payment.js";
export * from "./stellar/escrow-reader.js";
