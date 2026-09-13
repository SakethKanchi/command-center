/**
 * Discovery: go ask the boards, rather than filter the rows already stored.
 *
 * The dashboard's search could only ever narrow what ingest had already
 * written, which makes an empty result ambiguous between "no such job" and
 * "nobody has looked yet". This is the other half — a keyword and a place go
 * out to the sources, and what comes back is persisted through the same upsert
 * as every other ingest, so the derived search blob and experience window are
 * computed in exactly one place.
 */

import type { DiscoverResult, DiscoverSourceReport } from "@domain";
import type { ApiDeps } from "@server/api/app";
import { ok } from "@server/api/respond";
import { badRequest } from "@server/infra/errors";
import { ingestJobs, SOURCE_ADAPTERS } from "@server/ingest/registry";
import { listKnownLocations } from "@server/search/location";
import { Hono } from "hono";
import { z } from "zod";

const discoverBody = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  remote: z.boolean().optional(),
  /**
   * Not an enum: an id the registry does not know comes back as its own report
   * row rather than a 400. A typo in one of four requested boards must not
   * take down a discovery the other three could have served.
   */
  sources: z.array(z.string().trim().min(1).max(64)).nonempty().optional(),
  /**
   * Board token per source id, for the ATS sources that publish one company at
   * a time. Validated as a plain string here; each adapter escapes it to a
   * single path segment before it reaches a URL.
   */
  boards: z
    .record(z.string().min(1).max(64), z.string().trim().min(1).max(100))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const locationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("Invalid discovery request", result.error.flatten());
  }
  return result.data;
}

export function createDiscoverRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();

  routes.post("/discover", async (c) => {
    const body = parse(discoverBody, await c.req.json().catch(() => ({})));
    if (!body.query && !body.location) {
      throw badRequest("Discovery needs a query or a location.", {
        field: "query",
      });
    }

    // Every registered source by default, including the ones that will be
    // skipped. A report row saying greenhouse needs a company token is a better
    // answer than pretending greenhouse does not exist.
    const requested = body.sources ?? Object.keys(SOURCE_ADAPTERS);
    const result = await ingestJobs({
      sources: requested.map((id) => ({
        id,
        query: body.query,
        location: body.location,
        ...(body.boards?.[id] ? { board: body.boards[id] } : {}),
        ...(body.remote === undefined ? {} : { remote: body.remote }),
      })),
      ...(body.limit === undefined ? {} : { limit: body.limit }),
      repos: deps.repos,
    });

    // `id` inside ingest, `source` on the wire: the dashboard reads this next
    // to a job's own `source` column and the two have to be the same word.
    const bySource: DiscoverSourceReport[] = result.bySource.map((report) => ({
      source: report.id,
      fetched: report.fetched,
      ...(report.error === undefined ? {} : { error: report.error }),
      ...(report.skipped ? { skipped: true } : {}),
      ...(report.notes === undefined ? {} : { notes: report.notes }),
    }));

    const payload: DiscoverResult = {
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      bySource,
    };
    return ok(c, payload);
  });

  routes.get("/locations", (c) => {
    const query = parse(locationsQuery, c.req.query());
    return ok(c, {
      locations: listKnownLocations(deps.repos.db, query.limit),
    });
  });

  return routes;
}
