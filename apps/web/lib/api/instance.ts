import { apiGuard } from "../server/keys";
import { endpoints } from "./endpoints";
import { createService } from "./service";
import { liveDeps } from "./wiring";

/** The live `/v1` handlers: real dependencies, real keys and rate limits. */
export const v1 = endpoints(createService(liveDeps), apiGuard());
