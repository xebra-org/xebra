/**
 * What `api.xebra.exchange` serves: the versioned API and nothing else. The same Vercel project
 * answers both hosts, so without this the API host would also serve the site, `/admin` included.
 */
export const API_HOST = "api.xebra.exchange";
export const DOCS_API_URL = "https://docs.xebra.exchange/api";

export type HostDecision =
  | { action: "pass" }
  | { action: "redirect"; location: string }
  | { action: "not-found" };

export function decideApiHost(pathname: string): HostDecision {
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return { action: "pass" };
  if (pathname === "/" || pathname === "") return { action: "redirect", location: DOCS_API_URL };
  return { action: "not-found" };
}

export function isApiHost(host: string | null): boolean {
  return (host ?? "").toLowerCase().split(":")[0] === API_HOST;
}
