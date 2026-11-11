import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideGate } from "./lib/admin/gate";
import { decideApiHost, isApiHost } from "./lib/api/host";

/**
 * Two jobs, kept apart:
 *  - `api.xebra.exchange` serves `/v1` and nothing else (`lib/api/host.ts`);
 *  - the admin panel's gate. See lib/admin/gate.ts for why this is not the security boundary.
 */
export function middleware(req: NextRequest) {
  if (isApiHost(req.headers.get("host"))) {
    const decision = decideApiHost(req.nextUrl.pathname);
    if (decision.action === "pass") return NextResponse.next();
    if (decision.action === "redirect") return NextResponse.redirect(decision.location, 308);
    return new NextResponse(
      JSON.stringify({
        type: "https://docs.xebra.exchange/errors/not_found",
        title: "Not found",
        status: 404,
        detail: "The API lives under /v1. See https://docs.xebra.exchange/api.",
        code: "not_found",
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/problem+json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const decision = decideGate({
    password: process.env.ADMIN_PASSWORD,
    allowedIps: process.env.ADMIN_ALLOWED_IPS,
    authorization: req.headers.get("authorization"),
    clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });
  if (decision.allow) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }
  return new NextResponse(decision.status === 404 ? "Not found" : "Unauthorized", {
    status: decision.status,
    headers: decision.challenge
      ? { "WWW-Authenticate": 'Basic realm="xebra-admin", charset="UTF-8"' }
      : {},
  });
}

export const config = {
  matcher: [
    "/admin",
    "/admin/:path*",
    // Every path on the API host, and only there; the site's own pages never pass through this.
    // The value is a regular expression, so the dots are escaped. Hosts reach Vercel lower-cased.
    { source: "/:path*", has: [{ type: "host", value: "api\\.xebra\\.exchange" }] },
  ],
};
