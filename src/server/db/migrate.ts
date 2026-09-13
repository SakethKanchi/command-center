import { ensureProfileSchema } from "@server/profile/schema";
import { ensureJobSearchSchema } from "@server/search";
import { closeDb, openDatabase, resolveDatabasePath } from "./index";

/**
 * Apply the schema to the configured database.
 *
 * `openDatabase` already executes `schema.sql`, so this entrypoint exists to
 * make the step explicit in `npm run migrate` and to report where the file
 * landed — useful when `DATABASE_PATH` is set and the location is not obvious.
 */
const path = resolveDatabasePath();
const db = openDatabase(path);

// `schema.sql` can only create what is missing; columns added to a table that
// already exists need ALTER, which is what this reconciles.
const applied = ensureJobSearchSchema(db);
// The profile table is declared outside `schema.sql` for the same reason, so
// a migrate that skipped it would report a schema the server then changes.
const profileApplied = ensureProfileSchema(db);
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all() as Array<{ name: string }>;

db.close();
closeDb();

console.log(`Schema applied to ${path}`);
console.log(`${tables.length} tables: ${tables.map((t) => t.name).join(", ")}`);
if (applied.length > 0) {
  console.log(`${applied.length} column(s) added to jobs:`);
  for (const statement of applied) console.log(`  ${statement}`);
  console.log(
    "Run `npm run backfill:experience` to populate them for existing rows.",
  );
}
if (profileApplied.length > 0) {
  console.log("Created the profile table.");
}
