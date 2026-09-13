/**
 * The additive half of the jobs-search schema.
 *
 * `openDatabase` applies `schema.sql`, which is written entirely in
 * `CREATE ... IF NOT EXISTS` and therefore cannot add a column to a table that
 * already exists — and SQLite has no `ADD COLUMN IF NOT EXISTS`. A database
 * created before search shipped needs `ALTER TABLE`, so the columns are
 * declared in `schema.sql` for fresh databases and reconciled here for old
 * ones. The indexes live here rather than in `schema.sql` for the same reason:
 * they reference columns that an older file has not grown yet, and a
 * `CREATE INDEX` over a missing column would fail the whole schema apply.
 */

import type { Db } from "@server/db";

const ADDED_COLUMNS: Record<string, string> = {
  experience_min_years: "INTEGER",
  experience_max_years: "INTEGER",
  salary_annual: "INTEGER",
  location_country: "TEXT",
  location_region: "TEXT",
  contact_email: "TEXT",
  contact_email_manual: "TEXT",
  search_blob: "TEXT NOT NULL DEFAULT ''",
};

/**
 * The tag table, repeated here for the same reason as the columns: a database
 * created before tags shipped never ran this file's `CREATE TABLE`, and the
 * index below would fail against a missing table.
 */
const TAG_TABLE = `CREATE TABLE IF NOT EXISTS job_tags (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL CHECK (kind IN ('level','skill','employment','eligibility')),
  tag    TEXT NOT NULL,
  PRIMARY KEY (job_id, tag)
) WITHOUT ROWID`;

/**
 * Deliberately no index on `search_blob`: free text runs as
 * `LIKE '%term%'`, which no B-tree can serve, and FTS5 is not guaranteed to be
 * compiled into the SQLite that ships inside Node. At a few thousand postings a
 * scan over one prepared lowercase column is milliseconds and has no index to
 * fall out of sync.
 */
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source)",
  `CREATE INDEX IF NOT EXISTS idx_jobs_experience
     ON jobs(experience_min_years, experience_max_years)`,
  // A pay floor drops every row whose pay did not parse, so the index carries
  // the NULLs too rather than being partial: the same column also orders the
  // salary sort, which has to place the unparsed rows last.
  "CREATE INDEX IF NOT EXISTS idx_jobs_salary ON jobs(salary_annual DESC)",
  // Both geography columns are grouped and filtered on, and both are sparse:
  // plenty of postings state a city and no country at all.
  "CREATE INDEX IF NOT EXISTS idx_jobs_country ON jobs(location_country)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_region ON jobs(location_region)",
  "CREATE INDEX IF NOT EXISTS idx_job_tags_tag ON job_tags(tag, job_id)",
  // `postedWithinDays` reads the posting date and falls back to discovery,
  // because plenty of boards never publish one. The expression is indexed in
  // exactly the form the query uses.
  `CREATE INDEX IF NOT EXISTS idx_jobs_posted_or_discovered
     ON jobs(COALESCE(posted_at, discovered_at) DESC)`,
];

const reconciled = new WeakSet<Db>();

/**
 * Bring `jobs` up to the shape search queries expect. Idempotent, and cheap
 * enough to call on every repository construction.
 *
 * Returns the statements it actually had to run, so `npm run migrate` can say
 * whether it changed anything.
 */
export function ensureJobSearchSchema(db: Db): string[] {
  if (reconciled.has(db)) return [];

  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>
    ).map((column) => column.name),
  );

  const applied: string[] = [];
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (existing.has(name)) continue;
    const statement = `ALTER TABLE jobs ADD COLUMN ${name} ${type}`;
    db.exec(statement);
    applied.push(statement);
  }
  db.exec(TAG_TABLE);
  for (const statement of INDEXES) db.exec(statement);

  reconciled.add(db);
  return applied;
}
