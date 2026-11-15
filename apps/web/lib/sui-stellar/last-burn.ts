/**
 * The newest CCTP burn a Sui address has sent, read from Sui's public GraphQL service.
 *
 * Why: a wallet can report an error after it has already sent the transaction (it signed and
 * submitted, then lost the network while waiting for the result). The page asks for the newest burn
 * before signing and again after an error. A new digest means the transfer went through, so the
 * page follows it instead of inviting a second send.
 *
 * Only burns through Circle's TokenMessenger V2 package count, and only when Circle's own event
 * names this address as the depositor. All of it is public data.
 */

/** Circle's Sui TokenMessenger V2 package (same id as `@xebra/sdk` build/sui.ts). */
const TMM_V2_PACKAGE = "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830";
const DEPOSIT_FOR_BURN = `${TMM_V2_PACKAGE}::deposit_for_burn::DepositForBurn`;
const DEFAULT_GRAPHQL = "https://graphql.mainnet.sui.io/graphql";

/** How many of the address's newest transactions are searched for a burn. */
const LOOKBACK = 10;

export const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

export interface LastBurn {
  digest: string;
  destinationDomain: number;
}

export function suiGraphqlUrl(): string {
  return process.env.SUI_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL;
}

interface TxNode {
  digest?: unknown;
  effects?: {
    status?: unknown;
    events?: { nodes?: { contents?: { type?: { repr?: unknown }; json?: unknown } }[] };
  } | null;
}

/**
 * The newest successful burn by `sender` among `nodes` (oldest first, as GraphQL's `last` returns
 * them). Pure, so the rules are tested without the network.
 */
export function pickLastBurn(nodes: readonly TxNode[], sender: string): LastBurn | null {
  const who = sender.toLowerCase();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const tx = nodes[i];
    if (typeof tx?.digest !== "string" || tx.effects?.status !== "SUCCESS") continue;
    for (const ev of tx.effects.events?.nodes ?? []) {
      if (ev.contents?.type?.repr !== DEPOSIT_FOR_BURN) continue;
      const json = ev.contents.json as { depositor?: unknown; destination_domain?: unknown };
      if (typeof json?.depositor !== "string" || json.depositor.toLowerCase() !== who) continue;
      const domain = Number(json.destination_domain);
      if (!Number.isInteger(domain)) continue;
      return { digest: tx.digest, destinationDomain: domain };
    }
  }
  return null;
}

const QUERY = `query ($sender: SuiAddress!, $last: Int!) {
  transactions(last: $last, filter: { sentAddress: $sender }) {
    nodes { digest effects { status events { nodes { contents { type { repr } json } } } } }
  }
}`;

/** Throws when Sui's GraphQL service does not answer, so callers can tell "none" from "unknown". */
export async function lastBurn(
  sender: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LastBurn | null> {
  const res = await fetchImpl(suiGraphqlUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { sender, last: LOOKBACK } }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sui GraphQL answered ${res.status}`);
  const body = (await res.json()) as {
    data?: { transactions?: { nodes?: TxNode[] } };
    errors?: unknown[];
  };
  const nodes = body.data?.transactions?.nodes;
  if (!Array.isArray(nodes)) throw new Error("Sui GraphQL gave no transactions");
  return pickLastBurn(nodes, sender);
}
