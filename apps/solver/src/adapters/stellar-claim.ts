import {
  BASE_FEE,
  Contract,
  type Keypair,
  TransactionBuilder,
  nativeToScVal,
  type rpc,
} from "@stellar/stellar-sdk";
import type { ClaimAdapter, ClaimResult, FillResult } from "../fill-loop.js";
import { waitForTransaction } from "./horizon-wait.js";

/**
 * Calls `claim` on the Stellar-source XebraEscrow Soroban contract (contracts/stellar-soroban),
 * asserting the solver's Solana delivery tx as the falsifiable proof (see that contract's
 * `claim` doc comment — it cannot and does not verify this itself; that's the challenge
 * mechanism's job). Real code, compiled against @stellar/stellar-sdk's actual API
 * (`Contract.call`, `rpc.Server.prepareTransaction`/`sendTransaction`, `TransactionBuilder`), and
 * waits for the transaction to land, through Horizon (see horizon-wait.ts), before reporting a
 * claim. Run live on Stellar testnet on 2026-11-05 (scripts/e2e-demo/README.md).
 */
export function createStellarClaimAdapter(
  server: rpc.Server,
  escrowContractId: string,
  solverKeypair: Keypair,
  networkPassphrase: string,
  horizonUrl: string,
): ClaimAdapter {
  return {
    async claim(intentHash: string, fill: FillResult): Promise<ClaimResult> {
      const contract = new Contract(escrowContractId);
      const account = await server.getAccount(solverKeypair.publicKey());

      const op = contract.call(
        "claim",
        nativeToScVal(Buffer.from(intentHash.replace(/^0x/, ""), "hex"), { type: "bytes" }),
        nativeToScVal(solverKeypair.publicKey(), { type: "address" }),
        nativeToScVal(Buffer.from(fill.destTxRef), { type: "bytes" }),
        nativeToScVal(fill.deliveredAmount, { type: "i128" }),
      );

      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(solverKeypair);

      const result = await server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`claim tx submission failed: ${JSON.stringify(result.errorResult)}`);
      }

      // Submission is not inclusion. Only a confirmed claim may be written to the journal as done.
      await waitForTransaction(horizonUrl, result.hash);

      return { claimTxRef: result.hash };
    },
  };
}
