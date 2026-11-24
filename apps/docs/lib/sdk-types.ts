/**
 * Types the SDK reference renders with `AutoTypeTable` that are not one exported SDK type as they
 * stand. Each is a selection of SDK types, never a hand-written shape: the fields, their types and
 * their descriptions all still come from `packages/sdk/src`.
 */
import type { XebraApiError } from "../../../packages/sdk/src/index.js";

/** The fields of `XebraApiError` a caller reads, without the ones every `Error` has. */
export type XebraApiErrorFields = Pick<
  XebraApiError,
  "status" | "code" | "detail" | "extra" | "retryAfterMs"
>;
