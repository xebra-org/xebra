import type { NextConfig } from "next";

/**
 * `distDir` is overridable so a production build can never clobber a running dev server.
 *
 * Both commands default to `.next`. When `next build` runs while `next dev` is live it wipes
 * and rewrites that directory underneath the dev server, which then fails every request with
 * `ENOENT: routes-manifest.json`. The build looks fine; the dev server looks broken; nothing
 * in either message points at the other process.
 *
 * The build script sets `NEXT_DIST_DIR=.next-build`, so the two never share state.
 *
 * A webpack IgnorePlugin rule for /^@x402\// used to live here. It existed only because
 * wagmi's `wagmi/connectors` barrel statically pulled in every connector it ships, including
 * Coinbase Smart Wallet, which transitively imported @coinbase/cdp-sdk's optional x402
 * payments feature and failed the build on peer deps nothing here called. Wagmi is gone — the
 * EVM routes talk to the wallet's EIP-1193 provider directly (`lib/evm-rpc.ts`) and need no
 * connector framework — so the workaround went with it.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The link-preview images are drawn on first request and read these files at run time.
  outputFileTracingIncludes: {
    "/og/[...path]": ["./assets/og/*.ttf", "./public/chains/*.png", "./public/icon.svg"],
  },
  // Every written page has a Markdown copy at the same address plus `.md` (`/fees.md`, and
  // `/index.md` for the home page), served by `app/md/[...path]` for assistants and tools.
  async rewrites() {
    return [{ source: "/:path(.*)\\.md", destination: "/md/:path" }];
  },
};

export default nextConfig;
