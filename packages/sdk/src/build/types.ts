import type { ChainId } from "../core/chains/ids.js";

/** A transaction for the user's wallet to sign. Never signed, never sent, by Xebra. */
export type UnsignedTx =
  | { kind: "stellar"; xdr: string; networkPassphrase: string }
  | { kind: "evm"; chainId: number; to: `0x${string}`; data: `0x${string}`; value: "0" }
  | { kind: "sui"; json: string }
  /**
   * An Aptos Move script: Circle's precompiled burn and its arguments after the signer, in order
   * (`@xebra/sdk/build`'s `aptosBurnPayload` turns them into what a wallet takes).
   */
  | {
      kind: "aptos";
      chainId: number;
      bytecode: `0x${string}`;
      arguments: {
        amount: string;
        destinationDomain: number;
        mintRecipient: `0x${string}`;
        destinationCaller: `0x${string}`;
        burnToken: `0x${string}`;
        maxFee: string;
        minFinalityThreshold: number;
        hookData: `0x${string}`;
      };
    }
  /** A legacy Solana transaction, serialized without signatures, base64. */
  | { kind: "solana"; transaction: string };

/** One signature in a transfer, in the order the wallet should be asked. */
export interface TransferStep {
  id: "approve" | "burn" | "open_account" | "claim";
  chain: ChainId;
  /** One sentence a person can read before signing. */
  description: string;
  tx: UnsignedTx;
  /** When the transaction stops being valid (ISO 8601), or null when it does not expire. */
  expiresAt: string | null;
}
