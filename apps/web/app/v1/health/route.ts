import { preflight } from "../../../lib/api/http";
import { v1 } from "../../../lib/api/instance";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => v1.health(req);
export const OPTIONS = preflight;
