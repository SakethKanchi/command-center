import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "@server/api/app";
import { getDb } from "@server/db";
import { logger } from "@server/infra/logger";
import { createConfiguredLlmClient } from "@server/llm/configured";
import { createRepos } from "@server/repos";

// Node reads .env natively since 20.6, so there is no dotenv dependency here.
// Variables already present in the real environment win over the file, which is
// what you want when running under a process manager.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 8787);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const repos = createRepos(getDb());
const llm = createConfiguredLlmClient(repos.settings);
const app = createApp({ repos, llm, baseUrl });

// Serve the built client when it exists, so a single process can host the whole
// demo. In development Vite owns :5173 and proxies /api here instead.
//
// The SPA fallback deliberately excludes /api: without this, an unknown API
// path returns 200 text/html and the caller fails on JSON.parse instead of
// seeing a 404. A wrong URL should say so.
const clientDir = resolve("dist/web");
if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("/*", (c, next) => {
    if (c.req.path === "/health" || c.req.path.startsWith("/api/")) {
      return next();
    }
    return serveStatic({ path: "./dist/web/index.html" })(c, next);
  });
}

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("Command Center API listening", {
    port: info.port,
    baseUrl,
    client: existsSync(clientDir) ? "static" : "vite dev on :5173",
    model: llm.model,
  });
});
