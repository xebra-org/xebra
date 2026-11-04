import { z } from "zod";

const ConfigSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  /** Horizon, used only to confirm that a claim landed. */
  HORIZON_URL: z.string().url(),
  STELLAR_ESCROW_CONTRACT_ID: z.string().min(1),
  /** Base64-encoded raw Solana secret key. */
  SOLVER_SOLANA_KEYPAIR: z.string().min(1),
  /** Stellar secret seed (S...). */
  SOLVER_STELLAR_SECRET: z.string().min(1),
  /** Where the cursor and the record of deliveries live. Back it up; losing it risks a double delivery. */
  SOLVER_STATE_FILE: z.string().min(1).default("./solver-state.json"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  /**
   * First ledger to read events from on a fresh state file. Unset: about a day back (17,280
   * ledgers), which is more than any intent that is still worth filling. Soroban RPC only keeps
   * events for a limited window, so a value older than that is rejected by the RPC.
   */
  SOROBAN_START_LEDGER: z.coerce.number().int().positive().optional(),
});

export type SolverConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolverConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`solver: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
