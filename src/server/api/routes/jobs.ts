/**
 * Job browsing endpoints.
 *
 * Split out of `app.ts` because the query string is the feature here: every
 * filter the dashboard exposes has to survive a round trip through a URL, and
 * a bad value has to come back named rather than as an empty result the
 * candidate would read as "no such job exists".
 */

import {
  isJobTag,
  JOB_REGIONS,
  JOB_SORTS,
  JOB_STATUSES,
  type JobSearchQuery,
  type JobTag,
} from "@domain";
import type { ApiDeps } from "@server/api/app";
import { ok } from "@server/api/respond";
import { badRequest, notFound } from "@server/infra/errors";
import { searchJobs } from "@server/search";
import { Hono } from "hono";
import { z } from "zod";

/**
 * List keys whose values cannot themselves contain a comma — a status is an
 * enum, a source is a slug, a country is two letters, a region is a slug — so
 * CSV is a safe shorthand for them.
 */
const CSV_LIST_PARAMS = [
  "statuses",
  "sources",
  "countries",
  "regions",
] as const;

/**
 * `locations` is deliberately NOT comma-split. Places arrive as
 * "Toronto, Canada", and splitting turned one place into ["Toronto","Canada"];
 * OR-ed as substrings, "Canada" then matched the whole corpus and every city
 * returned the same rows. Multiple places are sent as repeated keys instead.
 * `tags` gets the same treatment: a tag is `kind:value`, so repeating the key
 * stays symmetrical with places and leaves room for values with punctuation.
 */
const LIST_PARAMS = [...CSV_LIST_PARAMS, "locations", "tags"] as const;

/**
 * Written out rather than coerced with `z.coerce.boolean()`, which treats every
 * non-empty string as true — including "false".
 */
const boolish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  statuses: z.array(z.enum(JOB_STATUSES)).optional(),
  sources: z.array(z.string().min(1).max(64)).optional(),
  locations: z.array(z.string().min(1).max(120)).optional(),
  // A two-letter code is uppercased here, at the boundary, so the filter
  // never depends on how a link was typed.
  countries: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((value) => value.toUpperCase()),
    )
    .optional(),
  regions: z.array(z.enum(JOB_REGIONS)).optional(),
  remote: boolish.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  minYears: z.coerce.number().int().min(0).max(60).optional(),
  maxYears: z.coerce.number().int().min(0).max(60).optional(),
  postedWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  hasSalary: boolish.optional(),
  // A floor of zero is not a floor: every posting with parseable pay clears
  // it, and the ones without would be dropped — which is `hasSalary=false`
  // spelled the long way round. Rejected rather than silently ignored.
  minSalary: z.coerce.number().int().min(1).max(10_000_000).optional(),
  // An unknown tag has to be rejected rather than ignored: silently dropping
  // it returns a wider result set than the URL claims to filter by.
  tags: z.array(z.custom<JobTag>(isJobTag, "Unknown tag")).optional(),
  sort: z.enum(JOB_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Collect the raw query string into the shape the schema expects.
 *
 * Empty values are dropped rather than parsed: a UI that renders `minScore=`
 * for an untouched slider means "no floor", and coercing that to 0 would be a
 * filter the candidate never asked for.
 */
function collectQuery(url: string): Record<string, unknown> {
  const params = new URL(url).searchParams;
  const raw: Record<string, unknown> = {};

  for (const key of LIST_PARAMS) {
    const splitOnComma = (CSV_LIST_PARAMS as readonly string[]).includes(key);
    const parts = params.getAll(key);
    const values = (splitOnComma ? parts.flatMap((v) => v.split(",")) : parts)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length > 0) raw[key] = values;
  }

  for (const [key, value] of params.entries()) {
    if (LIST_PARAMS.includes(key as (typeof LIST_PARAMS)[number])) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) raw[key] = trimmed;
  }

  return raw;
}

function parseSearchQuery(url: string): JobSearchQuery {
  const result = searchQuerySchema.safeParse(collectQuery(url));
  if (!result.success) {
    const flattened = result.error.flatten();
    const fields = Object.keys(flattened.fieldErrors);
    throw badRequest(
      `Invalid job search parameter: ${fields.join(", ")}`,
      flattened,
    );
  }
  return result.data;
}

/**
 * An empty string is how a cleared text input arrives, and it means "no
 * recipient" rather than "invalid address" — so it is normalised before the
 * email check rather than rejected by it.
 */
const contactSchema = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .nullable()
    .transform((value) => value || null)
    .refine(
      (value) => value === null || z.string().email().safeParse(value).success,
      { message: "Not a valid email address." },
    ),
});

export function createJobRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();

  // Registered before `/jobs/:id`, which would otherwise swallow "search".
  routes.get("/jobs/search", (c) =>
    ok(c, searchJobs(deps.repos, parseSearchQuery(c.req.url))),
  );

  routes.get("/jobs/:id", (c) => {
    const id = c.req.param("id");
    const job = deps.repos.jobs.getCard(id);
    if (!job) throw notFound(`Job ${id} not found.`);
    return ok(c, { job });
  });

  /**
   * Confirm, correct or clear the outreach recipient.
   *
   * The parser's answer is a candidate, not a decision: an address goes out
   * under the user's name, so the user gets the last word. `null` clears the
   * override and reveals whatever the posting states.
   */
  routes.post("/jobs/:id/contact", async (c) => {
    const id = c.req.param("id");
    const parsed = contactSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      throw badRequest(
        "Expected { email } holding a valid address, or null to clear it.",
        parsed.error.flatten(),
      );
    }
    const job = deps.repos.jobs.setContactEmail(id, parsed.data.email);
    if (!job) throw notFound(`Job ${id} not found.`);
    return ok(c, { job });
  });

  return routes;
}
