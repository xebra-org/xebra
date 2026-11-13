import {
  parseArcReceivesFrom,
  parseArcSendsTo,
  parseEvmMesh,
  parseStellarSendsTo,
} from "@xebra/sdk/core";

/**
 * The frontend's single source of network truth.
 *
 * # Why every variable is referenced literally
 *
 * `NEXT_PUBLIC_*` values are **inlined by webpack at compile time**, and that substitution is
 * purely textual: it only fires for a literal member expression like
 * `process.env.NEXT_PUBLIC_NETWORK`. A dynamic lookup — `process.env[name]` — cannot be
 * statically analyzed, so in the **client** bundle it resolves against an empty `process.env`
 * shim and yields `undefined` for everything.
 *
 * That is not theoretical: the first version of this file used a `required(name)` helper
 * doing exactly that, and it threw "NEXT_PUBLIC_NETWORK is not set" in the browser while the
 * variable was correctly set in the server process the whole time.
 *
 * **Never** add a variable here by indexing `process.env`. Add a literal line to RAW.
 * `scripts/check-env-files.sh` fails on any dynamic access in client-bundled code.
 *
 * # Why this file does no cross-validation
 *
 * Validation lives in `scripts/check-build-network.mjs`, which runs in plain Node before the
 * bundler. Importing `@xebra/network-config` here instead dragged its entire PRESETS table
 * into the client bundle — every network's contract addresses, RPC URLs and passphrases
 * shipped in every build. All public values, so not a secret leak, but it meant a bundle's
 * target network could not be determined by inspecting it, since mainnet and testnet
 * constants were both present regardless of which one it was built for.
 *
 * Re-validating in the browser would also prove nothing: by then the values are already
 * baked in. Coherence is a build-time property, checked at build time, once.
 *
 * # Why there are no fallbacks
 *
 * Because `NEXT_PUBLIC_*` is baked in at build time, a production deployment cannot correct a
 * frontend built against the wrong network. The previous defaults made that dangerous:
 *
 *   lib/wagmi.ts:  process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? "9001"          // anvil
 *   app/page.tsx:  ...PASSPHRASE ?? "Test SDF Network ; September 2015"    // TESTNET
 *
 * A single missing build arg produced a *working* testnet frontend rather than a failed
 * build. Every fallback is gone: a missing variable is a hard failure.
 */

/**
 * Literal references only — see the note above. Webpack replaces each with a string constant
 * at compile time; anything not written this way is `undefined` in the browser.
 */
const RAW = {
  NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK,
  NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
  NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS: process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS,
  NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS:
    process.env.NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS,
  NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID: process.env.NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID,
  NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  NEXT_PUBLIC_SOLANA_USDC_MINT: process.env.NEXT_PUBLIC_SOLANA_USDC_MINT,
  NEXT_PUBLIC_ARC_ENABLED: process.env.NEXT_PUBLIC_ARC_ENABLED,
  NEXT_PUBLIC_ARC_SENDS_TO: process.env.NEXT_PUBLIC_ARC_SENDS_TO,
  NEXT_PUBLIC_ARC_RECEIVES_FROM: process.env.NEXT_PUBLIC_ARC_RECEIVES_FROM,
  NEXT_PUBLIC_EVM_MESH: process.env.NEXT_PUBLIC_EVM_MESH,
  NEXT_PUBLIC_STELLAR_SENDS_TO: process.env.NEXT_PUBLIC_STELLAR_SENDS_TO,
  NEXT_PUBLIC_ARC_USE_WRAPPER: process.env.NEXT_PUBLIC_ARC_USE_WRAPPER,
  NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID:
    process.env.NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_LEGACY_CONTRACT_ID:
    process.env.NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_LEGACY_CONTRACT_ID,
} as const;

type RawKey = keyof typeof RAW;

/** Mainnet-only build. Kept as a local literal so this module pulls nothing into the client
 *  bundle; `scripts/check-build-network.mjs` validates the real values before the bundler
 *  runs. */
const KNOWN_NETWORKS = ["mainnet"] as const;
export type Network = (typeof KNOWN_NETWORKS)[number];

function required(name: RawKey): string {
  const value = RAW[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is not set. NEXT_PUBLIC_* values are inlined at BUILD time, so this must be present when the bundle is compiled — as an environment variable on Vercel or in CI, or via \`pnpm build\` / \`pnpm dev\`, which load .env.production through scripts/with-env.mjs. See docs/environments.md.`,
    );
  }
  return value.trim();
}

function optional(name: RawKey): string | null {
  const value = RAW[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

function resolveNetwork(): Network {
  const raw = required("NEXT_PUBLIC_NETWORK");
  if (!(KNOWN_NETWORKS as readonly string[]).includes(raw)) {
    throw new Error(`NEXT_PUBLIC_NETWORK="${raw}" is not one of: ${KNOWN_NETWORKS.join(", ")}`);
  }
  return raw as Network;
}

const network = resolveNetwork();

export const env = {
  network,
  sorobanRpcUrl: required("NEXT_PUBLIC_SOROBAN_RPC_URL"),
  /** Used only for confirmation polling, which needs no XDR decoding. */
  horizonUrl: required("NEXT_PUBLIC_HORIZON_URL"),
  stellarNetworkPassphrase: required("NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE"),
  /**
   * The destination asset is NOT a user input. For the CCTP rail it is native USDC by
   * definition — burn-and-mint moves the same asset — so it is derived from config per
   * network rather than typed in. See docs/environments.md.
   */
  usdcSacAddress: required("NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS"),
  /** Circle's TokenMessengerMinter, read client-side for the live burn fee. */
  cctpTokenMessengerId: required("NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS"),
  /**
   * Solana's CCTP domain (5). A Stellar transfer's domain comes from the destination picked
   * (`packages/sdk/src/core/chains/destinations.ts`); this only fills the admin panel's config, which sends no transfer.
   */
  destinationDomain: Number(required("NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID")),
  /**
   * Solana RPC, used server-side to confirm a recipient's token account exists (`/api/recipient`)
   * and behind the claim page's proxy (`/api/solana-rpc`), and by `/recover` to submit.
   */
  solanaRpcUrl: required("NEXT_PUBLIC_SOLANA_RPC_URL"),
  /** Solana's USDC mint, for deriving a recipient's token account. */
  usdcSolanaMint: required("NEXT_PUBLIC_SOLANA_USDC_MINT"),
  /**
   * Whether Arc is offered as a destination from Stellar. Off unless set to exactly `1`.
   *
   * A switch and not an inference, because two things outside this bundle have to be true first:
   * the wrapper must accept domain 26 (v2 was deployed with it; another wrapper's admin would
   * `propose_domain`, then `commit_domain` after the 48-hour timelock), and Circle's Forwarding
   * Service must be seen delivering a transfer to Arc through it. Offering Arc before either
   * would let someone sign a transfer the contract rejects, or burn one nobody delivers. The
   * flag is flipped when both are done, by the person who did them.
   */
  arcEnabled: optional("NEXT_PUBLIC_ARC_ENABLED") === "1",
  /**
   * The routes around Arc that call Circle directly, one direction at a time, each a
   * comma-separated list of chain names or `all`. Absent means none, and with both absent the
   * screen is the Stellar one alone.
   *
   *   - `NEXT_PUBLIC_ARC_SENDS_TO`: where Arc may send (EVM chains, and `solana`).
   *   - `NEXT_PUBLIC_ARC_RECEIVES_FROM`: which EVM chains may send into Arc.
   *   - `NEXT_PUBLIC_EVM_MESH`: EVM chains other than Arc that send to each other, every one to
   *     every other (any EVM chain to any EVM chain).
   *
   * Lists and not a yes/no because these routes have no contract of ours to refuse a bad one, so
   * a direction is meant to be switched on once a transfer has gone through it: Arc to all fifteen
   * went live after one testnet transfer each (2026-10-14), and
   * `scripts/test-evm-arc-forwarding-mainnet.sh` does the same with real money. A name that is not
   * a chain fails the build.
   * They gate *starting* a transfer only: `/claim` and the status routes serve every route
   * regardless, so a transfer already made is never stranded by a flag.
   */
  evmRoutes: {
    arcSendsTo: parseArcSendsTo(optional("NEXT_PUBLIC_ARC_SENDS_TO")),
    arcReceivesFrom: parseArcReceivesFrom(optional("NEXT_PUBLIC_ARC_RECEIVES_FROM")),
    evmMesh: parseEvmMesh(optional("NEXT_PUBLIC_EVM_MESH")),
  },
  /**
   * The EVM chains other than Arc that Stellar may send to, through the wrapper: a comma-separated
   * list of chain names, or `all`. Absent means none.
   *
   * Necessary and not sufficient. The wrapper must also have the chain's CCTP domain committed
   * (`propose_domain`, then `commit_domain` 48 hours later), and the form reads that list from the
   * contract: a chain named here appears only once it is committed. So `all` is safe to build with
   * before the chains are added, and each one switches on by itself as its commit lands.
   */
  stellarSendsTo: parseStellarSendsTo(optional("NEXT_PUBLIC_STELLAR_SENDS_TO")),
  /**
   * Send transfers out of a chain through Xebra's fee wrapper where one is pinned
   * (`XEBRA_WRAPPERS` in `packages/sdk/src/core/chains/evm.ts`), instead of calling Circle directly. Exactly `1` to
   * switch on. The address itself is never read from the environment: a transfer approves it for
   * the whole amount, so it changes only by a commit. With no wrapper pinned this does nothing.
   */
  arcUseWrapper: optional("NEXT_PUBLIC_ARC_USE_WRAPPER") === "1",
  /**
   * Intent/swap-rail only, which is out of scope: the product is a USDC bridge over CCTP.
   * Optional so a mainnet build is not blocked on deploying an escrow the product does not
   * use. Absent means the intent routes are unavailable, not that the build is broken.
   */
  escrowContractId: optional("NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID"),
  /**
   * Optional, as it had to be before the wrapper was deployed. Deliberately not `required()`:
   * the alternatives were blocking the build before deployment, or inventing a placeholder —
   * and a placeholder contract id in a mainnet bundle is exactly the kind of value that
   * silently sends funds nowhere. Absent means "the Stellar route is unavailable in this build".
   */
  cctpWrapperContractId: optional("NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID"),
  /** The retired v1 wrapper. Read-only, and only so the admin panel can show its rent running down
   *  until it is allowed to lapse. Nothing in the bridge flow reads it. */
  legacyWrapperContractId: optional("NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_LEGACY_CONTRACT_ID"),
} as const;

/** Whether the Stellar route, through the wrapper, can be offered in this build. */
export const isCctpRailConfigured = env.cctpWrapperContractId !== null;

/** True only for a build that will touch real money. Use it to gate destructive UI. */
export const isMainnet = network === "mainnet";
