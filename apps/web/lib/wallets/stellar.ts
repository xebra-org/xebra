import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import type { Connection, WalletEntry } from "./types";

/**
 * The Stellar wallets this app will sign with.
 *
 * Deliberately a short list. Every transfer and every admin call carries a Soroban authorization
 * tree that the wallet must sign entry by entry, and signing parity across wallets has been
 * checked for Freighter (see stellar-wallet.ts); LOBSTR is listed on the strength of its extension's
 * `signTransaction`, which is the only call open-intent.ts needs, and still wants a real transfer. Listing a wallet here is a promise that money
 * moves correctly through it, so it is added after a real transfer has gone through it, not
 * because the kit happens to support it.
 */
export const VERIFIED_STELLAR_WALLETS: ReadonlyArray<{
  id: string;
  name: string;
  installUrl: string;
}> = [
  { id: "freighter", name: "Freighter", installUrl: "https://www.freighter.app" },
  // Browser extension only. LOBSTR's phone app is not reachable through this module.
  { id: "lobstr", name: "LOBSTR", installUrl: "https://lobstr.co/signer-extension" },
];

/**
 * Asks each wallet whether it is there. `probe` is the page's own check (`probeStellarWallet`),
 * with a timeout long enough for a sleeping extension to wake; the kit is asked only for icons,
 * because its own availability answer gives up after 500 ms. No answer is reported as "not found".
 */
export async function stellarEntries(
  kit: StellarWalletsKit,
  probe: (id: string) => Promise<boolean | null>,
): Promise<WalletEntry[]> {
  const [supported, found] = await Promise.all([
    kit.getSupportedWallets().catch(() => []),
    Promise.all(VERIFIED_STELLAR_WALLETS.map((w) => probe(w.id))),
  ]);
  return VERIFIED_STELLAR_WALLETS.map((w, i) => {
    const info = supported.find((s) => s.id === w.id);
    return {
      key: `stellar:${w.id}`,
      family: "stellar" as const,
      name: w.name,
      icon: info?.icon && /^(data:image\/|https:\/\/)/.test(info.icon) ? info.icon : null,
      installed: found[i] === true,
      installUrl: w.installUrl,
    };
  });
}

/**
 * A wallet that answered "here" stays detected for the rest of the visit. An extension does not
 * uninstall itself mid-session, but it does stop answering while it sleeps, and a later "no
 * answer" must not take back a "detected" the screen already showed.
 */
export function keepDetected(previous: WalletEntry[], next: WalletEntry[]): WalletEntry[] {
  return next.map((entry) =>
    !entry.installed && previous.some((p) => p.key === entry.key && p.installed)
      ? { ...entry, installed: true }
      : entry,
  );
}

export const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/**
 * Checks whether the Stellar wallet is on the expected network (defaulting to Mainnet).
 * Wallets that support getNetwork() (where the wallet supports it) are checked against the expected passphrase;
 * wallets that cannot report a network (or throw an error) are allowed through.
 *
 * On mismatch, throws: "Your wallet is on Testnet. Switch it to Mainnet, then try again."
 */
export async function checkStellarNetwork(
  kit: { getNetwork?: () => Promise<{ networkPassphrase?: string; network?: string }> },
  expectedPassphrase = STELLAR_MAINNET_PASSPHRASE,
): Promise<void> {
  if (typeof kit?.getNetwork !== "function") return;
  let net: { network?: string; networkPassphrase?: string } | undefined;
  try {
    net = await kit.getNetwork();
  } catch {
    // Wallets that cannot report a network are allowed through, as today.
    return;
  }
  const passphrase = net?.networkPassphrase;
  if (passphrase && passphrase !== expectedPassphrase) {
    throw new Error("Your wallet is on Testnet. Switch it to Mainnet, then try again.");
  }
}

export const assertStellarNetwork = checkStellarNetwork;

export async function connectStellar(
  kit: StellarWalletsKit,
  entry: WalletEntry,
): Promise<Connection> {
  kit.setWallet(entry.key.replace("stellar:", ""));
  let address: string;
  try {
    ({ address } = await kit.getAddress());
    await checkStellarNetwork(kit);
  } catch (err) {
    const raw = err instanceof Error ? err.message : JSON.stringify(err);
    if (/Your wallet is on Testnet/i.test(raw)) {
      throw err;
    }
    // The kit's own text ("Freighter is not connected") names neither cause nor cure.
    if (/not connected|not available|not installed/i.test(raw)) {
      throw new Error(
        `${entry.name} did not respond. Check that the extension is installed, unlocked, and allowed on this site, then try again.`,
      );
    }
    throw err;
  }
  return { family: "stellar", walletKey: entry.key, walletName: entry.name, address };
}
