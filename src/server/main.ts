import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "@server/api/app";
import { closeDb, type Db, getDb, resolveDatabasePath } from "@server/db";
import { applyMigrations } from "@server/db/migrate";
import {
  type AppConfig,
  ConfigError,
  loadConfig,
  maskSecret,
} from "@server/infra/config";
import {
  failInterruptedRuns,
  installShutdownHandlers,
} from "@server/infra/lifecycle";
import { configureLogger, logger } from "@server/infra/logger";
import { createConfiguredLlmClient } from "@server/llm/configured";
import { createRepos } from "@server/repos";
import { resolveLlmConfig } from "@server/settings";

// Node reads .env natively since 20.6, so there is no dotenv dependency here.
// Variables already present in the real environment win over the file, which is
// what you want when running under a process manager.
if (existsSync(".env")) process.loadEnvFile(".env");

/**
 * Configuration is the one thing that must be settled before anything else,
 * including the logger: a process that cannot say what port it should bind has
 * nothing useful to do, and writing the complaint through a logger whose own
 * level came from the same broken environment would be circular.
 */
function bootConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(
      `${error.message}\n\nFix the variable(s) listed above and start again.\n`,
    );
    process.exit(1);
  }
}

const config = bootConfig();
configureLogger(config.log);

/**
 * Open the database and bring the schema up to date, or die saying which file
 * it could not use. A server that starts against an unreadable or stale
 * database only fails later, one route at a time.
 */
function bootDatabase(): Db {
  const databasePath = resolveDatabasePath();
  try {
    const db = getDb();
    // Applied rather than merely checked: both helpers are idempotent additive
    // DDL, this is a single-writer SQLite app, and `npm start` in a container
    // has nowhere to run a separate migrate step. See `db/migrate.ts` for the
    // full argument.
    const migration = applyMigrations(db);
    logger.info("Schema ready", {
      databasePath,
      tables: migration.tables.length,
      applied: migration.statements.length,
      ...(migration.statements.length > 0
        ? { statements: migration.statements }
        : {}),
    });
    return db;
  } catch (error) {
    logger.error("Database is not usable, refusing to start", {
      databasePath,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

const db = bootDatabase();

const repos = createRepos(db);

// A previous process killed without a signal it could handle (SIGKILL, OOM,
// power) leaves its run rows at `running`. They cannot belong to this process,
// so reconcile them now rather than showing a run that will never move.
const stale = failInterruptedRuns(
  repos,
  "The server stopped without finishing this run.",
);
if (stale.agentRuns > 0 || stale.syncRuns > 0) {
  logger.warn("Reconciled runs left over from a previous process", stale);
}

const llm = createConfiguredLlmClient(repos.settings);
const app = createApp({ repos, llm, baseUrl: config.baseUrl });

// A missing model key is a soft degrade by design: every other surface works
// and the agent says so when a step needs the model. Announce it once at boot
// so the operator is not surprised by the first failed step.
const llmConfig = resolveLlmConfig(repos.settings);
if (llmConfig.apiKey === "") {
  logger.warn(
    "No model API key configured; agent steps that call the model will fail until one is set in Settings or LLM_API_KEY",
    { model: llmConfig.model, baseUrl: llmConfig.baseUrl },
  );
}

// Serve the built client when it exists, so a single process can host the whole
// demo. In development Vite owns :5173 and proxies /api here instead.
//
// The SPA fallback deliberately excludes /api: without this, an unknown API
// path returns 200 text/html and the caller fails on JSON.parse instead of
// seeing a 404. A wrong URL should say so.
const clientDir = resolve("dist/web");
const hasClient = existsSync(clientDir);
if (hasClient) {
  if (config.isProduction) {
    // A source map hands the reader the original TypeScript. The bundler does
    // not emit them today; this makes that a property of the server rather
    // than of a build flag someone may flip.
    app.use("/*", async (c, next) => {
      if (c.req.path.endsWith(".map")) return c.text("Not Found", 404);
      await next();
    });
  }
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("/*", (c, next) => {
    if (c.req.path === "/health" || c.req.path.startsWith("/api/")) {
      return next();
    }
    return serveStatic({ path: "./dist/web/index.html" })(c, next);
  });
}

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.info("Command Center API listening", {
      host: config.host,
      port: info.port,
      baseUrl: config.baseUrl,
      env: config.nodeEnv,
      client: hasClient ? "static" : "vite dev on :5173",
      model: llm.model,
      llmApiKey: maskSecret(llmConfig.apiKey),
      composioApiKeyEnv: config.credentials.composioApiKey ? "set" : "unset",
    });
  },
);

installShutdownHandlers({
  server,
  repos,
  closeDatabase: closeDb,
  timeoutMs: config.shutdownTimeoutMs,
});
