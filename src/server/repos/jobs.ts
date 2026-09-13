import { randomUUID } from "node:crypto";
import type {
  Job,
  JobBrief,
  JobCard,
  JobContactSource,
  JobRegion,
  JobStatus,
  JobTag,
  NewJob,
  SkillGroup,
} from "@domain";
import { JOB_STATUSES, parseJobTag } from "@domain";
import {
  type Db,
  fromSqliteBool,
  nowIso,
  parseJsonColumn,
  toSqliteBool,
  transaction,
} from "@server/db";
import { badRequest } from "@server/infra/errors";
import { buildJobSearchFields } from "@server/search/fields";
import { ensureJobSearchSchema } from "@server/search/schema";
import { TAG_ORDER } from "@server/search/tags";

export type JobFilter = {
  status?: JobStatus[];
  /** Floor on the LLM fit score. Absent or 0 means no floor. */
  minScore?: number;
  limit?: number;
};

export type JobsRepo = {
  list(filter?: JobFilter): Job[];
  get(id: string): Job | null;
  getByUrl(url: string): Job | null;
  upsertMany(rows: NewJob[]): { inserted: number; updated: number };
  update(id: string, patch: Partial<Job>): Job | null;
  counts(): Record<JobStatus, number>;
  /**
   * Set or clear the user-confirmed outreach recipient. Clearing reveals the
   * address parsed from the posting again, if there is one.
   */
  setContactEmail(id: string, email: string | null): JobCard | null;
  /** A posting plus everything derived from its prose, as search returns it. */
  getCard(id: string): JobCard | null;
  /**
   * Recompute every derived search column, and every tag, from the stored
   * posting text. For rows written before search existed, and after a parser
   * or vocabulary change.
   */
  refreshSearchFields(): { scanned: number; changed: number };
};

type JobRow = {
  id: string;
  source: string;
  source_job_id: string | null;
  title: string;
  company: string;
  location: string | null;
  is_remote: number | null;
  url: string;
  apply_url: string | null;
  description_text: string;
  salary_text: string | null;
  posted_at: string | null;
  status: string;
  score: number | null;
  score_reason: string | null;
  brief: string | null;
  tailored_headline: string | null;
  tailored_summary: string | null;
  tailored_skills: string | null;
  resume_path: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  salary_annual: number | null;
  location_country: string | null;
  location_region: string | null;
  contact_email: string | null;
  contact_email_manual: string | null;
  search_blob: string;
  discovered_at: string;
  applied_at: string | null;
  updated_at: string;
};

type Bindable = string | number | null;

/**
 * Collapse the two contact columns into the one answer every reader wants: is
 * there somebody to write to, and who decided that. A user-confirmed address
 * always wins over the parser's, which is the whole reason they are separate
 * columns.
 */
function contactOf(row: JobRow): {
  contactEmail: string | null;
  contactEmailSource: JobContactSource | null;
} {
  if (row.contact_email_manual) {
    return {
      contactEmail: row.contact_email_manual,
      contactEmailSource: "manual",
    };
  }
  if (row.contact_email) {
    return { contactEmail: row.contact_email, contactEmailSource: "posting" };
  }
  return { contactEmail: null, contactEmailSource: null };
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    source: row.source,
    sourceJobId: row.source_job_id,
    title: row.title,
    company: row.company,
    location: row.location,
    isRemote: fromSqliteBool(row.is_remote),
    url: row.url,
    applyUrl: row.apply_url,
    descriptionText: row.description_text,
    salaryText: row.salary_text,
    ...contactOf(row),
    postedAt: row.posted_at,
    status: row.status as JobStatus,
    score: row.score === null ? null : Number(row.score),
    scoreReason: row.score_reason,
    brief: parseJsonColumn<JobBrief>(row.brief),
    tailoredHeadline: row.tailored_headline,
    tailoredSummary: row.tailored_summary,
    tailoredSkills: parseJsonColumn<SkillGroup[]>(row.tailored_skills),
    resumePath: row.resume_path,
    discoveredAt: row.discovered_at,
    appliedAt: row.applied_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The search view of a posting: the same row plus what was derived from its
 * prose at write time. Exported so the search layer maps rows exactly once,
 * the same way every other read does.
 *
 * Tags arrive separately because they live in their own table; the caller
 * loads them for a whole page in one query rather than per row.
 */
export function mapJobCard(row: unknown, tags: JobTag[] = []): JobCard {
  const jobRow = row as JobRow;
  return {
    ...mapJob(jobRow),
    experienceMinYears:
      jobRow.experience_min_years === null
        ? null
        : Number(jobRow.experience_min_years),
    experienceMaxYears:
      jobRow.experience_max_years === null
        ? null
        : Number(jobRow.experience_max_years),
    salaryAnnual:
      jobRow.salary_annual === null ? null : Number(jobRow.salary_annual),
    locationCountry: jobRow.location_country,
    // Stored as text, so a row written before a region was retired from the
    // vocabulary reads back as whatever it said; the filter and the label both
    // work off the current list.
    locationRegion: (jobRow.location_region as JobRegion | null) ?? null,
    tags,
  };
}

/**
 * Tags for a set of postings, keyed by job id and ordered by the vocabulary so
 * two postings carrying the same tags always render them the same way.
 *
 * Exported because both reads that build a `JobCard` — one row from the
 * repository, a page of rows from search — need it, and neither should join
 * per row.
 */
export function selectJobTags(
  db: Db,
  ids: readonly string[],
): Record<string, JobTag[]> {
  if (ids.length === 0) return {};
  const rows = db
    .prepare(
      `SELECT job_id, tag FROM job_tags
        WHERE job_id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as unknown as Array<{ job_id: string; tag: string }>;

  const byJob: Record<string, JobTag[]> = {};
  for (const row of rows) {
    // A row left behind by a vocabulary the extractor no longer has is
    // dropped rather than handed to the UI: the card's contract is the
    // current vocabulary, and a tag outside it has no label and no filter.
    const parsed = parseJobTag(row.tag);
    if (!parsed) continue;
    const seen = byJob[row.job_id];
    if (seen) seen.push(parsed.tag);
    else byJob[row.job_id] = [parsed.tag];
  }
  for (const tags of Object.values(byJob)) {
    tags.sort((a, b) => (TAG_ORDER[a] ?? 0) - (TAG_ORDER[b] ?? 0));
  }
  return byJob;
}

/**
 * A re-ingest refreshes what the board owns and nothing else. `score`,
 * `score_reason`, `brief`, `tailored_*`, `resume_path`, `status` and
 * `applied_at` are agent output: clobbering them would silently undo a scoring
 * pass every time a crawler ran again. `url` is left alone too — it is the
 * natural key, and rewriting it can collide with another row's unique index.
 */
const REFRESH_POSTING_FIELDS = `
  title = excluded.title,
  company = excluded.company,
  location = excluded.location,
  is_remote = excluded.is_remote,
  apply_url = excluded.apply_url,
  description_text = excluded.description_text,
  salary_text = excluded.salary_text,
  contact_email = excluded.contact_email,
  posted_at = excluded.posted_at,
  search_blob = excluded.search_blob,
  experience_min_years = excluded.experience_min_years,
  experience_max_years = excluded.experience_max_years,
  salary_annual = excluded.salary_annual,
  location_country = excluded.location_country,
  location_region = excluded.location_region,
  updated_at = excluded.updated_at`;

const UPSERT_JOB_SQL = `
INSERT INTO jobs (
  id, source, source_job_id, title, company, location, is_remote, url, apply_url,
  description_text, salary_text, posted_at, status, discovered_at, updated_at,
  search_blob, experience_min_years, experience_max_years, salary_annual,
  location_country, location_region, contact_email
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url) DO UPDATE SET${REFRESH_POSTING_FIELDS}
ON CONFLICT(source, source_job_id) WHERE source_job_id IS NOT NULL DO UPDATE SET${REFRESH_POSTING_FIELDS}`;

/**
 * Tags are rewritten wholesale per posting rather than diffed: the extractor
 * is a pure function of the posting text, so the set it returns IS the row's
 * tags, and a delete-then-insert inside the caller's transaction cannot leave
 * a tag behind that the text no longer supports.
 */
const DELETE_TAGS_SQL = "DELETE FROM job_tags WHERE job_id = ?";
const INSERT_TAG_SQL =
  "INSERT OR IGNORE INTO job_tags (job_id, kind, tag) VALUES (?, ?, ?)";

const JOB_COLUMNS: Record<string, string> = {
  source: "source",
  sourceJobId: "source_job_id",
  title: "title",
  company: "company",
  location: "location",
  isRemote: "is_remote",
  url: "url",
  applyUrl: "apply_url",
  descriptionText: "description_text",
  salaryText: "salary_text",
  postedAt: "posted_at",
  status: "status",
  score: "score",
  scoreReason: "score_reason",
  brief: "brief",
  tailoredHeadline: "tailored_headline",
  tailoredSummary: "tailored_summary",
  tailoredSkills: "tailored_skills",
  resumePath: "resume_path",
  discoveredAt: "discovered_at",
  appliedAt: "applied_at",
  updatedAt: "updated_at",
};

const JSON_JOB_FIELDS: Record<string, true> = {
  brief: true,
  tailoredSkills: true,
};

/**
 * Patch fields whose change invalidates something derived: the search blob,
 * the experience window, the annualized pay, or the tags.
 */
const POSTING_TEXT_FIELDS: Record<string, true> = {
  title: true,
  company: true,
  location: true,
  descriptionText: true,
  salaryText: true,
};

function bindJobValue(field: string, value: unknown): Bindable {
  if (JSON_JOB_FIELDS[field]) {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }
  if (field === "isRemote") return toSqliteBool(value as boolean | null);
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  throw badRequest(`Job field "${field}" cannot hold a ${typeof value}.`, {
    field,
  });
}

export function createJobsRepo(db: Db): JobsRepo {
  // Older databases predate the search columns, and `schema.sql` cannot add a
  // column to a table that already exists. Every entrypoint builds its repos
  // here, which makes this the one chokepoint that covers all of them.
  ensureJobSearchSchema(db);

  const get = (id: string): Job | null => {
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapJob(row as JobRow) : null;
  };

  /**
   * Rewrite one posting's tags. Runs inside whatever transaction the caller
   * already holds, so a posting and its tags are never visible out of step
   * with each other.
   */
  const writeTags = (jobId: string, tags: readonly JobTag[]): void => {
    db.prepare(DELETE_TAGS_SQL).run(jobId);
    if (tags.length === 0) return;
    const insert = db.prepare(INSERT_TAG_SQL);
    for (const tag of tags) {
      // The kind is the tag's own prefix; storing it as a column keeps the
      // facet's GROUP BY off string functions.
      const kind = tag.slice(0, tag.indexOf(":"));
      insert.run(jobId, kind, tag);
    }
  };

  const getCard = (id: string): JobCard | null => {
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapJobCard(row, selectJobTags(db, [id])[id] ?? []) : null;
  };

  return {
    list(filter = {}) {
      const clauses: string[] = [];
      const params: Bindable[] = [];

      if (filter.status && filter.status.length > 0) {
        clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
        params.push(...filter.status);
      }
      // An unscored row is "not yet judged", not "judged zero", so a floor of 0
      // must still show it. Only a positive floor filters on the column, which
      // also drops NULL scores the way SQL comparison already does.
      if (filter.minScore !== undefined && filter.minScore > 0) {
        clauses.push("score >= ?");
        params.push(filter.minScore);
      }

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      let sql = `SELECT * FROM jobs${where} ORDER BY discovered_at DESC, rowid DESC`;
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(filter.limit);
      }

      const rows = db.prepare(sql).all(...params) as unknown as JobRow[];
      return rows.map(mapJob);
    },

    get,

    getByUrl(url) {
      const row = db.prepare("SELECT * FROM jobs WHERE url = ?").get(url) as
        | unknown
        | undefined;
      return row ? mapJob(row as JobRow) : null;
    },

    upsertMany(rows) {
      if (rows.length === 0) return { inserted: 0, updated: 0 };

      const writeBatch = () => {
        const upsert = db.prepare(UPSERT_JOB_SQL);
        const findByUrl = db.prepare("SELECT id FROM jobs WHERE url = ?");
        const findBySourceId = db.prepare(
          "SELECT id FROM jobs WHERE source = ? AND source_job_id = ?",
        );

        let inserted = 0;
        let updated = 0;

        for (const row of rows) {
          // The upsert itself cannot report which branch it took — `changes` is
          // 1 either way — so existence is probed first, on the same indexes the
          // conflict targets use.
          const existing = (findByUrl.get(row.url) ??
            (row.sourceJobId
              ? findBySourceId.get(row.source, row.sourceJobId)
              : undefined)) as { id: string } | undefined;

          const stamp = nowIso();
          const search = buildJobSearchFields(row);
          // Reusing the existing id is what lets the tags be rewritten in the
          // same pass: the upsert's own id argument is ignored on conflict, so
          // a fresh uuid here would leave the tags attached to nothing.
          const id = existing?.id ?? randomUUID();
          upsert.run(
            id,
            row.source,
            row.sourceJobId ?? null,
            row.title,
            row.company,
            row.location ?? null,
            toSqliteBool(row.isRemote),
            row.url,
            row.applyUrl ?? null,
            row.descriptionText ?? "",
            row.salaryText ?? null,
            row.postedAt ?? null,
            row.status ?? "discovered",
            stamp,
            stamp,
            search.searchBlob,
            search.experienceMinYears,
            search.experienceMaxYears,
            search.salaryAnnual,
            search.locationCountry,
            search.locationRegion,
            search.contactEmail,
          );
          writeTags(id, search.tags);

          if (existing) updated += 1;
          else inserted += 1;
        }

        return { inserted, updated };
      };

      // Reentrant: a caller may already hold `transaction(repos.db, ...)` to
      // make a multi-repository write atomic, and SQLite rejects a nested BEGIN.
      return db.isTransaction ? writeBatch() : transaction(db, writeBatch);
    },

    update(id, patch) {
      const assignments: string[] = [];
      const params: Bindable[] = [];

      for (const [field, value] of Object.entries(patch)) {
        if (field === "id") continue; // identifies the row, never a writable field
        if (value === undefined) continue;
        const column = JOB_COLUMNS[field];
        if (!column) {
          throw badRequest(`Unknown job field "${field}".`, { field });
        }
        assignments.push(`${column} = ?`);
        params.push(bindJobValue(field, value));
      }

      // The derived columns and tags are a function of the posting text, so
      // they are recomputed exactly when that text moves — not on a score or
      // status write, which is the overwhelming majority of updates.
      const rewritesText = Object.keys(patch).some(
        (field) =>
          POSTING_TEXT_FIELDS[field] && patch[field as keyof Job] !== undefined,
      );
      const current = rewritesText ? get(id) : null;
      const derived = current
        ? buildJobSearchFields({
            title: patch.title ?? current.title,
            company: patch.company ?? current.company,
            location:
              patch.location === undefined ? current.location : patch.location,
            descriptionText: patch.descriptionText ?? current.descriptionText,
            salaryText:
              patch.salaryText === undefined
                ? current.salaryText
                : patch.salaryText,
          })
        : null;
      if (derived) {
        assignments.push(
          "search_blob = ?",
          "experience_min_years = ?",
          "experience_max_years = ?",
          "salary_annual = ?",
          "location_country = ?",
          "location_region = ?",
          "contact_email = ?",
        );
        params.push(
          derived.searchBlob,
          derived.experienceMinYears,
          derived.experienceMaxYears,
          derived.salaryAnnual,
          derived.locationCountry,
          derived.locationRegion,
          derived.contactEmail,
        );
      }

      if (!("updatedAt" in patch)) {
        assignments.push("updated_at = ?");
        params.push(nowIso());
      }

      params.push(id);
      const apply = () => {
        const result = db
          .prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = ?`)
          .run(...params);
        if (result.changes === 0) return null;
        // Tags follow the same statement, so a posting whose text changed can
        // never be visible carrying the previous text's tags.
        if (derived) writeTags(id, derived.tags);
        return get(id);
      };
      return db.isTransaction ? apply() : transaction(db, apply);
    },

    counts() {
      const counts = Object.fromEntries(
        JOB_STATUSES.map((status) => [status, 0]),
      ) as Record<JobStatus, number>;

      const rows = db
        .prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status")
        .all() as unknown as Array<{ status: string; total: number }>;

      for (const row of rows) {
        counts[row.status as JobStatus] = Number(row.total);
      }
      return counts;
    },

    getCard,

    setContactEmail(id, email) {
      // Writes the user-owned column only. The parser keeps its own, so
      // clearing a manual address falls back to whatever the posting states
      // rather than to nothing.
      const trimmed = email?.trim() || null;
      const result = db
        .prepare(
          "UPDATE jobs SET contact_email_manual = ?, updated_at = ? WHERE id = ?",
        )
        .run(trimmed, nowIso(), id);
      if (result.changes === 0) return null;
      return getCard(id);
    },

    refreshSearchFields() {
      const rows = db
        .prepare(
          `SELECT id, title, company, location, description_text, salary_text,
                  search_blob, experience_min_years, experience_max_years,
                  salary_annual, location_country, location_region, contact_email
           FROM jobs`,
        )
        .all() as unknown as JobRow[];
      const storedTags = selectJobTags(
        db,
        rows.map((row) => row.id),
      );

      // Deliberately does not touch `updated_at`: these columns are derived
      // from the posting, and reparsing them is not the board changing its mind.
      const write = db.prepare(
        `UPDATE jobs
            SET search_blob = ?, experience_min_years = ?,
                experience_max_years = ?, salary_annual = ?,
                location_country = ?, location_region = ?, contact_email = ?
          WHERE id = ?`,
      );

      const apply = () => {
        let changed = 0;
        for (const row of rows) {
          const search = buildJobSearchFields({
            title: row.title,
            company: row.company,
            location: row.location,
            descriptionText: row.description_text,
            salaryText: row.salary_text,
          });
          const minYears =
            row.experience_min_years === null
              ? null
              : Number(row.experience_min_years);
          const maxYears =
            row.experience_max_years === null
              ? null
              : Number(row.experience_max_years);
          const salary =
            row.salary_annual === null ? null : Number(row.salary_annual);
          // Both halves are compared before either is written, because a
          // vocabulary change moves the tags while leaving every column
          // identical — and that is exactly the backfill this exists for.
          const columnsMatch =
            search.searchBlob === row.search_blob &&
            search.experienceMinYears === minYears &&
            search.experienceMaxYears === maxYears &&
            search.salaryAnnual === salary &&
            search.locationCountry === row.location_country &&
            search.locationRegion === row.location_region &&
            search.contactEmail === row.contact_email;
          const stored = storedTags[row.id] ?? [];
          const tagsMatch =
            stored.length === search.tags.length &&
            stored.every((tag, index) => tag === search.tags[index]);
          if (columnsMatch && tagsMatch) continue;

          if (!columnsMatch) {
            write.run(
              search.searchBlob,
              search.experienceMinYears,
              search.experienceMaxYears,
              search.salaryAnnual,
              search.locationCountry,
              search.locationRegion,
              search.contactEmail,
              row.id,
            );
          }
          if (!tagsMatch) writeTags(row.id, search.tags);
          changed += 1;
        }
        return { scanned: rows.length, changed };
      };

      return db.isTransaction ? apply() : transaction(db, apply);
    },
  };
}
