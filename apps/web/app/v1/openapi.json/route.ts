import { buildOpenApiDocument } from "@xebra/sdk/openapi";
import { CORS, preflight } from "../../../lib/api/http";

/** The OpenAPI 3.1 description of `/v1`, generated from the schemas the handlers validate with. */
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(buildOpenApiDocument(), {
    headers: { ...CORS, "Cache-Control": "public, s-maxage=3600" },
  });
}
export const OPTIONS = preflight;
