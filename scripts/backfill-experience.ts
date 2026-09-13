/**
 * Recompute every derived search field for every stored posting.
 *
 * Postings ingested before search existed carry an empty `search_blob`, no
 * experience range, no annualized pay and no tags, which makes them invisible
 * to free text, to the years filter, to a pay floor and to the whole tag rail.
 * Re-ingesting would fix that too, but it also re-fetches every board and
 * depends on the posting still being live. This reparses what is already on
 * disk. Safe to run repeatedly, and the right thing to run after the parser or
 * the tag vocabulary changes.
 *
 *   npm run backfill:experience
 */
import { closeDb, getDb, resolveDatabasePath } from "@server/db";
import { createRepos } from "@server/repos";

type Tally = {
  total: number;
  withRange: number;
  searchable: number;
  withSalary: number;
  withTags: number;
};

const path = resolveDatabasePath();
const db = getDb();
const repos = createRepos(db);

const tally = (): Tally =>
  db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN experience_min_years IS NOT NULL
                         OR experience_max_years IS NOT NULL THEN 1 ELSE 0 END) AS withRange,
              SUM(CASE WHEN search_blob != '' THEN 1 ELSE 0 END) AS searchable,
              SUM(CASE WHEN salary_annual IS NOT NULL THEN 1 ELSE 0 END) AS withSalary,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM job_tags WHERE job_tags.job_id = jobs.id)
                       THEN 1 ELSE 0 END) AS withTags
         FROM jobs`,
    )
    .get() as unknown as Tally;

const before = tally();
const { scanned, changed } = repos.jobs.refreshSearchFields();
const after = tally();

console.log(`Backfilled ${path}`);
console.log(`  scanned      ${scanned}`);
console.log(`  rewritten    ${changed}`);
console.log(
  `  searchable   ${Number(after.searchable ?? 0)} of ${after.total} (was ${Number(before.searchable ?? 0)})`,
);
console.log(
  `  experience   ${Number(after.withRange ?? 0)} of ${after.total} now have a parsed range (was ${Number(before.withRange ?? 0)})`,
);
console.log(
  `  pay          ${Number(after.withSalary ?? 0)} of ${after.total} now have an annualized figure (was ${Number(before.withSalary ?? 0)})`,
);
console.log(
  `  tagged       ${Number(after.withTags ?? 0)} of ${after.total} carry at least one tag (was ${Number(before.withTags ?? 0)})`,
);

closeDb();
