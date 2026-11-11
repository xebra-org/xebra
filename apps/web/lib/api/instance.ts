import { endpoints } from "./endpoints";
import { createService } from "./service";
import { liveDeps } from "./wiring";

/** The live `/v1` handlers. */
export const v1 = endpoints(createService(liveDeps));
