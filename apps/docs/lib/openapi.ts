import { createOpenAPI } from "fumadocs-openapi/server";
import spec from "../../../packages/sdk/openapi.json";

/**
 * The API reference is generated from the same document the SDK ships: the zod schemas in
 * packages/sdk produce it, and a drift test there keeps it in step with the code.
 */
export const openapi = createOpenAPI({
  input: ["../../packages/sdk/openapi.json"],
});

type Paths = Record<string, Record<string, { operationId?: string }>>;

/** `GET /v1/routes` -> `list-routes`, from the operation's id in the spec. */
export function operationSlug(method: string, path: string): string {
  const id = (spec.paths as Paths)[path]?.[method]?.operationId ?? `${method}-${path}`;
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
