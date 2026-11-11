// Writes openapi.json from the built package. Run `pnpm build` first (the `openapi` script does).
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../dist/api/openapi.js";

writeFileSync(
  new URL("../openapi.json", import.meta.url),
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
);
console.log("wrote openapi.json");
