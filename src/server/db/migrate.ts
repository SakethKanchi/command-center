import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureProfileSchema } from "@server/profile/schema";
import { ensureJobSearchSchema } from "@server/search";
import { closeDb, type Db, openDatabase, resolveDatabasePath } from "./index";

/**
 * Schema reconciliation, shared by `npm run migrate` and by server boot.
 *
 * `openDatabase` already executes `schema.sql`, which can only create what is
 * missing. Columns added to a table that already exists need ALTER, which is
 * what the `ensure*Schema` helpers reconcile. Both are idempotent, so calling
 * this on every boot costs one `PRAGMA table_info` per table and removes the
 * class of failure where the process starts against a schema older than the
 * code — the alternative (refuse to start, print the pending statements) buys
 * review time this app has no use for: it is single-user, the statements are
 * additive column adds, and there is no second writer to coordinate with.
 */
export type MigrationReport = {
  /** DDL actually executed, empty when the schema was already current. */
  readonly statements: readonly string[];
  readonly profileCreated: boolean;
  readonly tables: readonly string[];
};

export function applyMigrations(db: Db): MigrationReport {
  const statements = ensureJobSearchSchema(db);
  // The profile table is declared outside `schema.sql` for the same reason, so
  // a migrate that skipped it would report a schema the server then changes.
  const profileCreated = ensureProfileSchema(db).length > 0;
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  return { statements, profileCreated, tables };
}

/**
 * CLI form. Guarded so that importing this module from the server does not
 * open a second handle to the database or print to stdout.
 */
function main(): void {
  const path = resolveDatabasePath();
  const db = openDatabase(path);
  const report = applyMigrations(db);

  db.close();
  closeDb();

  console.log(`Schema applied to ${path}`);
  console.log(`${report.tables.length} tables: ${report.tables.join(", ")}`);
  if (report.statements.length > 0) {
    console.log(`${report.statements.length} column(s) added to jobs:`);
    for (const statement of report.statements) console.log(`  ${statement}`);
    console.log(
      "Run `npm run backfill:experience` to populate them for existing rows.",
    );
  }
  if (report.profileCreated) {
    console.log("Created the profile table.");
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
