import { notFound } from "../../../lib/api/host";
import { preflight } from "../../../lib/api/http";

/**
 * Everything under `/v1` that no route file answers, `/v1` itself included. Without this the site's
 * HTML 404 page answers, which an SDK client that parses problems reports as `invalid_response`.
 * OPTIONS is the CORS preflight every other `/v1` route answers, so it answers that here too.
 */
export const dynamic = "force-dynamic";

const noSuchEndpoint = () =>
  notFound("The API has no such endpoint. See https://docs.xebra.exchange/api.");

export const GET = noSuchEndpoint;
export const HEAD = noSuchEndpoint;
export const POST = noSuchEndpoint;
export const PUT = noSuchEndpoint;
export const PATCH = noSuchEndpoint;
export const DELETE = noSuchEndpoint;
export const OPTIONS = preflight;
