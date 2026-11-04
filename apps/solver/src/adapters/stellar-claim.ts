import {
  BASE_FEE,
  Contract,
  type Keypair,
  TransactionBuilder,
  nativeToScVal,
  type rpc,
} from "@stellar/stellar-sdk";
import type { ClaimAdapter, ClaimResult, FillResult } from "../fill-loop.js";

/**
 * Calls `claim` on the Stellar-source XebraEscrow Soroban contract (contracts/stellar-soroban),
 * asserting the solver's Solana delivery tx as the falsifiable proof (see that contract's
 * `claim` doc comment — it cannot and does not verify this itself; that's the challenge
 * mechanism's job). Real code, compiled against @stellar/stellar-sdk's actual API
 * (`Contract.call`, `rpc.Server.prepareTransaction`/`sendTransaction`/`pollTransaction`,
 * `TransactionBuilder`), and waits for the transaction to land before reporting a claim. Not yet
 * run against a live Soroban RPC from here: the 2026-08-14 testnet run in scripts/e2e-demo
 * called the same `claim` through the `stellar` CLI.
 */
export function createStellarClaimAdapter(
  server: rpc.Server,
  escrowContractId: string,
  solverKeypair: Keypair,
  networkPassphrase: string,
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
      const confirmed = await server.pollTransaction(result.hash, {
        attempts: 30,
        sleepStrategy: () => 1000,
      });
      if (confirmed.status !== "SUCCESS") {
        throw new Error(`claim tx ${result.hash} did not succeed: ${confirmed.status}`);
      }

      return { claimTxRef: result.hash };
    },
  };
}
