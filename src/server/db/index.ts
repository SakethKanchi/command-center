import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * SQLite access via Node's built-in driver.
 *
 * `node:sqlite` means no native module to compile and no prebuild to match
 * against the local Node ABI — the whole class of "works on my machine"
 * install failures simply does not exist here.
 *
 * The class is pulled off `process.getBuiltinModule` rather than imported as a
 * value, and the type comes in through a type-only import that is erased before
 * bundling. Reason: `node:sqlite` is still flagged experimental, so Node lists
 * it in `module.builtinModules` *with* the `node:` prefix. Vite's builtin check
 * strips the prefix, looks up a bare `sqlite`, misses, and then tries to resolve
 * it as a file — which breaks collection for every test that transitively
 * imports this module. Going through `getBuiltinModule` keeps the real module
 * under `tsx`/`node` while giving the bundler nothing to resolve.
 */
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export type Db = DatabaseSyncType;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function resolveDatabasePath(): string {
  const fromEnv = process.env.DATABASE_PATH?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.env.DATA_DIR?.trim() ?? "data", "command-center.db");
}

/**
 * Open a database and apply the schema.
 *
 * The schema is idempotent (`CREATE TABLE IF NOT EXISTS` throughout), so this
 * doubles as the migration step. At this size a migration ledger would be
 * ceremony; when the first destructive change lands, that is when it earns one.
 */
export function openDatabase(path = resolveDatabasePath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

let shared: Db | null = null;

/** Process-wide handle for the server. Tests open their own via `openDatabase`. */
export function getDb(): Db {
  if (!shared) shared = openDatabase();
  return shared;
}

export function closeDb(): void {
  shared?.close();
  shared = null;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * `node:sqlite` exposes no transaction helper, and a hand-rolled BEGIN without
 * this wrapper leaves the connection inside an open transaction when a callback
 * throws — which then poisons every later write with "cannot start a transaction
 * within a transaction".
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** ISO-8601 UTC, the only timestamp format this schema stores. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite has no boolean type; these two keep the coercion in one place. */
export const toSqliteBool = (
  value: boolean | null | undefined,
): number | null =>
  value === null || value === undefined ? null : value ? 1 : 0;

export const fromSqliteBool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : Number(value) !== 0;

/** Parse a JSON column, treating malformed content as absent rather than fatal. */
export function parseJsonColumn<T>(value: unknown): T | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
