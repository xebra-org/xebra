import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Twoslash runs the TypeScript compiler at build; it must not be bundled.
  serverExternalPackages: ["typescript", "twoslash"],
  // Workspace packages ship built ESM; the SDK is read for its types and samples.
  transpilePackages: ["@xebra/sdk"],
  async redirects() {
    return [
      // The docs are the whole site.
      { source: "/", destination: "/docs", permanent: false },
      // `api.xebra.exchange/` and the API's 404 point here.
      { source: "/api", destination: "/docs/api", permanent: true },
      // Every problem response's `type` is https://docs.xebra.exchange/errors/<code>.
      { source: "/errors", destination: "/docs/errors", permanent: true },
      { source: "/errors/:code", destination: "/docs/errors/:code", permanent: true },
    ];
  },
};

export default withMDX(config);
