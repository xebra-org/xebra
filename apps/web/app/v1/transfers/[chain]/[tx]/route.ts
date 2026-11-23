import { preflight } from "../../../../../lib/api/http";
import { v1 } from "../../../../../lib/api/instance";

export const dynamic = "force-dynamic";
// A Sui poll may start the relayer, which runs after the answer is sent (see `lib/sui-stellar/relay-kick.ts`).
export const maxDuration = 120;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ chain: string; tx: string }> },
) {
  return v1.getTransfer(req, await params);
}
export const OPTIONS = preflight;
