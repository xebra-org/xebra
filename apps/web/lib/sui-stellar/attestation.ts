import { SUI_DOMAIN } from "@xebra/sdk/core";
import { irisBaseUrl, irisFetch } from "../server/iris";

/**
 * Circle's view of a Sui burn. Kept apart from the Stellar code so that asking "has it been attested?"
 * does not load the whole Stellar SDK.
 */
export type AttestationState =
  | { state: "unknown"; reason: string }
  | { state: "pending" }
  | { state: "complete"; message: string; attestation: string };

/**
 * Circle's view of a burn, by the chain it was made on (Sui unless told otherwise) and its
 * transaction. 404 and "no message" are "not yet", never an error.
 */
export async function readAttestation(
  digest: string,
  sourceDomain: number = SUI_DOMAIN,
): Promise<AttestationState> {
  const res = await irisFetch(
    `${irisBaseUrl()}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(digest)}`,
    { cache: "no-store" },
  );
  if (res.status === 404)
    return { state: "unknown", reason: "Circle has not indexed this burn yet" };
  if (!res.ok) throw new Error(`Circle returned ${res.status}`);
  const body = (await res.json()) as {
    messages?: Array<{ message: string; attestation: string | null; status: string }>;
  };
  const first = body.messages?.[0];
  if (!first) return { state: "unknown", reason: "no CCTP message in that transaction" };
  if (first.status !== "complete" || !first.attestation || first.attestation === "PENDING") {
    return { state: "pending" };
  }
  return { state: "complete", message: first.message, attestation: first.attestation };
}

export const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
