import { CONNECTOR_PROVIDERS } from "@domain";
import { decideAgentStep, runApplyForMe } from "@server/agent/apply-for-me";
import { createConnectorRoutes } from "@server/api/routes/connectors";
import { createDiscoverRoutes } from "@server/api/routes/discover";
import { createJobRoutes } from "@server/api/routes/jobs";
import { createProfileRoutes } from "@server/api/routes/profile";
import { createResumeRoutes } from "@server/api/routes/resume";
import { createSettingsRoutes } from "@server/api/routes/settings";
import {
  connectConnector,
  pushCommandCenter,
} from "@server/connectors/service";
import {
  buildCommandCenterSnapshot,
  summarizeSnapshot,
} from "@server/connectors/snapshot";
import { badRequest, notFound } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import { ingestJobs, listSourceAdapters } from "@server/ingest/registry";
import type { LlmClient } from "@server/llm";
import type { RepoBundle } from "@server/repos";
import { Hono } from "hono";
import { z } from "zod";
import { ok, respondWithError } from "./respond";

export type ApiDeps = {
  repos: RepoBundle;
  llm: LlmClient;
  /** Public origin used to build tracked resume links. */
  baseUrl: string;
  /** Injected so a test can exercise provider calls without a network. */
  fetchImpl?: typeof fetch;
};

/**
 * The assembled HTTP surface: every API route plus the health probe.
 * Callers mount static assets and listeners around this.
 */
export type ApiApp = Hono;

const providerParam = z.enum(CONNECTOR_PROVIDERS);

const snapshotQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

const syncBody = z.object({
  providers: z
    .array(z.enum(["google_sheets", "notion"]))
    .nonempty()
    .optional(),
});

const applyBody = z.object({
  jobId: z.string().min(1),
  /**
   * Defaults to `dry_run`. An omitted mode must never mean live: a mis-scripted
   * call should draft and verify, never email a recruiter.
   */
  mode: z.enum(["dry_run", "live"]).default("dry_run"),
  contactEmail: z.string().email().max(320).optional(),
  rescore: z.boolean().default(false),
  force: z.boolean().default(false),
});

const decisionBody = z.object({
  decision: z.enum(["approve", "deny"]),
  decidedBy: z.string().min(1).max(255).default("dashboard"),
});

const ingestBody = z.object({
  sources: z
    .array(
      z.object({
        id: z.string().min(1),
        board: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
      }),
    )
    .nonempty(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const runsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Parse with zod, surfacing field errors as a 400 rather than a 500. */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("Invalid request", result.error.flatten());
  }
  return result.data;
}

export function createApp(deps: ApiDeps): ApiApp {
  const app = new Hono();
  app.onError(respondWithError);

  // An unknown /api path must answer in the same envelope as every other API
  // response. Hono's default is plain text, which makes a client-side typo look
  // like a malformed payload rather than a wrong URL.
  app.notFound((c) => {
    if (!c.req.path.startsWith("/api/")) return c.text("Not Found", 404);
    return respondWithError(notFound(`No API route for ${c.req.path}.`), c);
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", at: new Date().toISOString() }),
  );

  const api = new Hono();

  api.get("/snapshot", (c) => {
    const query = parse(snapshotQuery, c.req.query());
    const snapshot = buildCommandCenterSnapshot(deps.repos, query);
    return ok(c, { snapshot, summary: summarizeSnapshot(snapshot) });
  });

  api.get("/sources", (c) =>
    ok(c, {
      sources: listSourceAdapters().map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        needsBoardToken: adapter.needsBoardToken,
      })),
    }),
  );

  api.post("/ingest", async (c) => {
    const body = parse(ingestBody, await c.req.json().catch(() => ({})));
    const result = await ingestJobs({ ...body, repos: deps.repos });
    logger.info("Ingest complete", {
      inserted: result.inserted,
      updated: result.updated,
    });
    return ok(c, result);
  });

  // GET /connectors and /disconnect now live in the connectors router, which
  // dispatches by transport (direct OAuth or Composio). /connect stays here:
  // it verifies already-provisioned direct credentials.

  api.post("/connectors/:provider/connect", async (c) => {
    const provider = parse(providerParam, c.req.param("provider"));
    const health = await connectConnector({ provider }, { repos: deps.repos });
    return ok(c, { health });
  });

  /**
   * Push every lane to the requested destinations.
   *
   * Answers 200 with per-provider reports even when one destination failed: the
   * caller needs to see which app is behind, and one bad connector does not
   * invalidate the others.
   */
  api.post("/sync", async (c) => {
    const body = parse(syncBody, await c.req.json().catch(() => ({})));
    const result = await pushCommandCenter(
      { providers: body.providers, trigger: "manual" },
      { repos: deps.repos },
    );
    return ok(c, {
      reports: result.reports,
      skipped: result.skipped,
      summary: summarizeSnapshot(result.snapshot),
    });
  });

  api.get("/sync-runs", (c) => {
    const provider = parse(providerParam, c.req.query("provider"));
    return ok(c, {
      runs: deps.repos.connectors.listSyncRuns({
        provider,
        accountKey: "default",
        limit: 20,
      }),
    });
  });

  api.post("/agent/apply", async (c) => {
    const body = parse(applyBody, await c.req.json().catch(() => ({})));
    const run = await runApplyForMe(body, {
      repos: deps.repos,
      llm: deps.llm,
      baseUrl: deps.baseUrl,
    });
    return ok(c, { run });
  });

  api.get("/agent/runs", (c) => {
    const query = parse(runsQuery, c.req.query());
    return ok(c, { runs: deps.repos.agent.listRuns({ limit: query.limit }) });
  });

  api.get("/agent/runs/:id", (c) => {
    const run = deps.repos.agent.getRunDetail(c.req.param("id"));
    if (!run) throw notFound(`Agent run ${c.req.param("id")} not found.`);
    return ok(c, { run });
  });

  api.get("/agent/approvals", (c) =>
    ok(c, { steps: deps.repos.agent.listStepsAwaitingApproval() }),
  );

  api.post("/agent/steps/:id/decision", async (c) => {
    const body = parse(decisionBody, await c.req.json().catch(() => ({})));
    const run = await decideAgentStep(
      { stepId: c.req.param("id"), ...body },
      { repos: deps.repos, llm: deps.llm, baseUrl: deps.baseUrl },
    );
    return ok(c, { run });
  });

  // Mounted before the inline router so the connectors router's GET /connectors
  // and /disconnect win over anything left at the top level.
  app.route("/api", createConnectorRoutes(deps));
  app.route("/api", createJobRoutes(deps));
  app.route("/api", createDiscoverRoutes(deps));
  app.route("/api", createProfileRoutes(deps));
  app.route("/api", createResumeRoutes(deps));
  app.route("/api", createSettingsRoutes(deps));
  app.route("/api", api);

  /**
   * Tracked resume-link redirect.
   *
   * Bot detection is intentionally crude but conservative: a false "human"
   * would inflate the engagement signal and trigger a premature follow-up, so
   * anything that looks automated is recorded as a bot and excluded.
   */
  app.get("/r/:token", (c) => {
    const link = deps.repos.resumeLinks.getByToken(c.req.param("token"));
    if (!link) throw notFound("Unknown link.");

    const userAgent = c.req.header("user-agent") ?? null;
    deps.repos.resumeLinks.recordClick({
      linkId: link.id,
      isLikelyBot: looksAutomated(userAgent),
      userAgent,
    });
    return c.redirect(link.destinationUrl, 302);
  });

  return app;
}

const AUTOMATION_HINTS = [
  "bot",
  "crawler",
  "spider",
  "preview",
  "scan",
  "monitor",
  "curl",
  "wget",
  "python",
  "go-http",
  "java/",
  "headless",
  "slackbot",
  "whatsapp",
  "facebookexternalhit",
  "google-read-aloud",
];

function looksAutomated(userAgent: string | null): boolean {
  if (!userAgent) return true;
  const value = userAgent.toLowerCase();
  return AUTOMATION_HINTS.some((hint) => value.includes(hint));
}
