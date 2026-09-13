import type { Db } from "@server/db";

export type SettingsRepo = {
  get(key: string): string | null;
  /** A null value deletes the row: absent and "unset" are the same state. */
  set(key: string, value: string | null): void;
  all(): Record<string, string>;
};

export function createSettingsRepo(db: Db): SettingsRepo {
  return {
    get(key) {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key) as unknown as { value: string | null } | undefined;
      return row?.value ?? null;
    },

    set(key, value) {
      if (value === null) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(key);
        return;
      }
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },

    all() {
      const rows = db
        .prepare("SELECT key, value FROM settings ORDER BY key ASC")
        .all() as unknown as Array<{ key: string; value: string | null }>;
      const settings: Record<string, string> = {};
      for (const row of rows) {
        if (row.value !== null) settings[row.key] = row.value;
      }
      return settings;
    },
  };
}
