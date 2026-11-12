import { defineConfig } from "tsup";

/**
 * One build for the workspace and for npm. The private `@xebra/*` packages the SDK uses (the EVM
 * encoders) are bundled in, because npm users cannot install them; every public dependency stays
 * external and is listed in package.json.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "build/index": "src/build/index.ts",
    "intents/index": "src/intents/index.ts",
    "api/openapi": "src/api/openapi.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  // The base tsconfig is incremental, which the declaration bundler cannot use.
  dts: { resolve: [/^@xebra\//], compilerOptions: { incremental: false, composite: false } },
  noExternal: [/^@xebra\//],
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
