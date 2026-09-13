/**
 * The `profile` table, created outside `schema.sql`.
 *
 * `openDatabase` applies `schema.sql` on every open, and that file is written
 * entirely in `CREATE ... IF NOT EXISTS`, which cannot grow a table that
 * already exists — SQLite has no `ADD COLUMN IF NOT EXISTS`. Declaring the
 * whole table here instead means a database created before the profile editor
 * shipped grows it on next open, and a future field is one `ALTER` in this
 * same function rather than a split between two files. Same shape as
 * `ensureJobSearchSchema`.
 */

import type { Db } from "@server/db";

/**
 * Single-row table, keyed by a constant id. The array-valued fields are JSON
 * TEXT, exactly as `jobs.brief` and `jobs.tailored_skills` already are: SQLite
 * has no array type, and child tables for links, bullets and skill keywords
 * would buy nothing when the profile is only ever read and written whole.
 */
const TABLE = `
  CREATE TABLE IF NOT EXISTS profile (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    headline   TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT,
    location   TEXT,
    summary    TEXT NOT NULL DEFAULT '',
    links      TEXT NOT NULL DEFAULT '[]',
    skills     TEXT NOT NULL DEFAULT '[]',
    roles      TEXT NOT NULL DEFAULT '[]',
    projects   TEXT NOT NULL DEFAULT '[]',
    education  TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`;

const reconciled = new WeakSet<Db>();

/** Empty for a table that does not exist, which is how absence is detected. */
function profileColumns(db: Db): Set<string> {
  const rows = db.prepare("PRAGMA table_info(profile)").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((column) => column.name));
}

/**
 * Bring the profile store up to the shape the repository expects. Idempotent,
 * and cheap enough to call on every repository construction.
 *
 * Returns the statements it actually had to run, so `npm run migrate` can say
 * whether it changed anything.
 */
export function ensureProfileSchema(db: Db): string[] {
  if (reconciled.has(db)) return [];

  const applied: string[] = [];
  const columns = profileColumns(db);
  if (columns.size === 0) {
    db.exec(TABLE);
    applied.push(TABLE.trim());
  } else if (!columns.has("projects")) {
    // A database created before the projects section shipped. The default
    // matters: the column is NOT NULL and every existing row predates it.
    const alter =
      "ALTER TABLE profile ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'";
    db.exec(alter);
    applied.push(alter);
  }

  reconciled.add(db);
  return applied;
}
