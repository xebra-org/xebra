import {
  FreighterModule,
  LobstrModule,
  type ModuleInterface,
  StellarWalletsKit,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import { env } from "./env";
import { patient } from "./wallet-wake";

/**
 * Freighter and the LOBSTR browser extension. Stellar Wallets Kit supports more, but
 * transaction-signing parity across wallets isn't independently verified here — see
 * docs/architecture.md §2's "verify at build time" note before adding more modules. LOBSTR's
 * extension has no `signAuthEntry`, which is fine: open-intent.ts signs the whole transaction.
 *
 * # The network is derived, never defaulted
 *
 * This function used to default to `WalletNetwork.TESTNET`. On a mainnet build that meant the
 * wallet was asked to sign against the wrong network while every other part of the app was
 * correctly configured for mainnet — the exact wrong-network class of bug the whole config
 * layer exists to prevent, hiding in a default argument.
 *
 * The passphrase is the authoritative network identifier, so it is the thing mapped here
 * rather than a separate flag that could drift from it.
 */
const NETWORK_BY_PASSPHRASE: Record<string, WalletNetwork> = {
  [WalletNetwork.PUBLIC]: WalletNetwork.PUBLIC,
  [WalletNetwork.TESTNET]: WalletNetwork.TESTNET,
};

/**
 * One instance of each module, shared by the kit and by `probeStellarWallet`. Built on first use
 * rather than at import, so nothing here runs during server rendering.
 */
let modules: ModuleInterface[] | null = null;
function stellarModules(): ModuleInterface[] {
  modules ??= [patient(new FreighterModule()), patient(new LobstrModule())];
  return modules;
}

/**
 * Whether a wallet extension is there: true or false when it answered, null when it did not answer
 * in time.
 *
 * The kit's own `getSupportedWallets` cannot be used for this. It races each wallet against a fixed
 * 500 ms timer that answers "not available", and a browser extension that has been idle goes to
 * sleep and needs longer than that to wake. So the screen said "not detected" for a wallet that was
 * installed and would connect fine, and only said "detected" for one opened a moment ago. The
 * question is also what wakes the extension, so asking again soon after gets a real answer.
 */
export async function probeStellarWallet(id: string, timeoutMs = 5_000): Promise<boolean | null> {
  const mod = stellarModules().find((m) => m.productId === id);
  if (!mod) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([mod.isAvailable().catch(() => false), silent]);
  } finally {
    clearTimeout(timer);
  }
}

export function createStellarWalletKit(): StellarWalletsKit {
  const network = NETWORK_BY_PASSPHRASE[env.stellarNetworkPassphrase];
  if (!network) {
    throw new Error(
      `No wallet network matches the configured passphrase "${env.stellarNetworkPassphrase}". Refusing to guess — signing against the wrong network is unrecoverable.`,
    );
  }

  return new StellarWalletsKit({
    network,
    selectedWalletId: "freighter",
    modules: stellarModules(),
  });
}
