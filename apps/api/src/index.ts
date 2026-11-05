/**
 * @xebra/api — tRPC over Postgres, for the intent rail. Not deployed, and nothing in apps/web
 * calls it any more (the `/intent/[hash]` page was removed); see docs/architecture.md §8.
 */

import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { startObservability } from "@xebra/observability";
import pino from "pino";
import { createContextFactory, createDbFromEnv } from "./context.js";
import { appRouter } from "./router.js";

const logger = pino({ name: "api" });

async function main() {
  const db = createDbFromEnv();
  const port = Number(process.env.PORT ?? 4000);
  const obs = startObservability({ serviceName: "api" });

  const server = createHTTPServer({
    router: appRouter,
    createContext: createContextFactory(db),
  });

  server.listen(port);
  logger.info({ port }, "api: listening");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "api: shutting down");
      server.close(() => {
        obs.shutdown().finally(() => process.exit(0));
      });
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "api: fatal startup error");
  process.exit(1);
});
