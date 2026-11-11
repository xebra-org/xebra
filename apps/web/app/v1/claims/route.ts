import { preflight } from "../../../lib/api/http";
import { v1 } from "../../../lib/api/instance";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => v1.createClaim(req);
export const OPTIONS = preflight;
