import type { Route } from "@xebra/sdk";
import { EVM_CHAINS, isEvmChainId } from "@xebra/sdk/core";

const ROUTES_URL = "https://api.xebra.exchange/v1/routes";

const OTHER_NAMES: Record<string, string> = { stellar: "Stellar", solana: "Solana", sui: "Sui" };

export function chainName(id: string): string {
  return isEvmChainId(id) ? EVM_CHAINS[id].name : (OTHER_NAMES[id] ?? id);
}

export type RoutesResult =
  | { ok: true; routes: Route[]; complete: boolean; at: Date }
  | { ok: false };

/** The live list from the API. A failure is an answer too: the page says so instead of failing. */
export async function loadRoutes(doFetch: typeof fetch = fetch): Promise<RoutesResult> {
  try {
    const res = await doFetch(ROUTES_URL, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    } as RequestInit);
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { routes?: Route[]; complete?: boolean };
    if (!Array.isArray(body.routes)) return { ok: false };
    return { ok: true, routes: body.routes, complete: body.complete !== false, at: new Date() };
  } catch {
    return { ok: false };
  }
}

/** Groups routes by the chain they start on, in the order the API lists them. */
export function groupBySource(routes: Route[]): Array<{ from: string; to: Route[] }> {
  const groups = new Map<string, Route[]>();
  for (const r of routes) {
    const list = groups.get(r.from) ?? [];
    list.push(r);
    groups.set(r.from, list);
  }
  return [...groups].map(([from, to]) => ({ from, to }));
}

/** Every route Xebra sends on right now, read from `GET /v1/routes` (refreshed every 5 minutes). */
export async function RoutesTable() {
  const result = await loadRoutes();
  if (!result.ok) {
    return (
      <p className="rounded-lg border p-4 text-sm text-fd-muted-foreground">
        The live list is unavailable right now. Ask the API directly:{" "}
        <code>GET https://api.xebra.exchange/v1/routes</code>.
      </p>
    );
  }
  return (
    <div className="not-prose overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="px-4 py-2 font-medium">From</th>
            <th className="px-4 py-2 font-medium">To</th>
            <th className="px-4 py-2 font-medium">Speeds</th>
          </tr>
        </thead>
        <tbody>
          {groupBySource(result.routes).flatMap(({ from, to }) =>
            to.map((r, i) => (
              <tr key={`${r.from}-${r.to}`} className="border-b last:border-0">
                <td className="px-4 py-2 align-top">{i === 0 ? chainName(from) : ""}</td>
                <td className="px-4 py-2">{chainName(r.to)}</td>
                <td className="px-4 py-2 text-fd-muted-foreground">{r.speeds.join(", ")}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-xs text-fd-muted-foreground">
        Read from <code>GET /v1/routes</code> at {result.at.toISOString().slice(0, 16)}Z.
        {result.complete ? "" : " Part of the list could not be read just now; it may be short."}
      </p>
    </div>
  );
}
