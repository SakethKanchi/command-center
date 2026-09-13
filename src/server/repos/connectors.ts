import { randomUUID } from "node:crypto";
import type {
  Connector,
  ConnectorConfig,
  ConnectorCredentials,
  ConnectorEntityKind,
  ConnectorProvider,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorSummary,
  ConnectorSyncRun,
  ConnectorSyncRunStatus,
  ConnectorSyncTrigger,
} from "@domain";
import { type Db, nowIso, parseJsonColumn, transaction } from "@server/db";
import { notFound } from "@server/infra/errors";

export type ConnectorRecordInput = {
  entityKind: ConnectorEntityKind;
  entityId: string;
  remoteId: string;
  remoteUrl?: string | null;
  contentHash: string;
};

export type SyncRunFilter = {
  connectorId?: string;
  provider?: ConnectorProvider;
  accountKey?: string;
  limit?: number;
};

export type ConnectorsRepo = {
  get(id: string): Connector | null;
  getByProvider(
    provider: ConnectorProvider,
    accountKey?: string,
  ): Connector | null;
  list(): Connector[];
  /** The only connector shape an API route may return. */
  toSummary(connector: Connector): ConnectorSummary;
  upsertConnected(input: {
    provider: ConnectorProvider;
    accountKey?: string;
    displayName?: string | null;
    credentials?: ConnectorCredentials | null;
    config?: ConnectorConfig | null;
  }): Connector;
  updateState(input: {
    id: string;
    status?: ConnectorStatus;
    credentials?: ConnectorCredentials | null;
    config?: ConnectorConfig | null;
    displayName?: string | null;
    lastConnectedAt?: string | null;
    lastSyncedAt?: string | null;
    lastError?: string | null;
  }): Connector | null;
  disconnect(id: string): Connector | null;
  startSyncRun(input: {
    connectorId: string | null;
    provider: ConnectorProvider;
    accountKey?: string;
    trigger?: ConnectorSyncTrigger;
  }): ConnectorSyncRun;
  finishSyncRun(input: {
    id: string;
    status: ConnectorSyncRunStatus;
    recordsConsidered?: number;
    recordsCreated?: number;
    recordsUpdated?: number;
    recordsUnchanged?: number;
    recordsFailed?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): ConnectorSyncRun | null;
  listSyncRuns(filter?: SyncRunFilter): ConnectorSyncRun[];
  /** Keyed `${entityKind}:${entityId}` — the key the adapters push against. */
  getRecords(connectorId: string): Map<string, ConnectorRecord>;
  upsertRecords(
    connectorId: string,
    entries: ConnectorRecordInput[],
  ): ConnectorRecord[];
};

type ConnectorRow = {
  id: string;
  provider: string;
  account_key: string;
  display_name: string | null;
  status: string;
  credentials: string | null;
  config: string | null;
  last_connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SyncRunRow = {
  id: string;
  connector_id: string | null;
  provider: string;
  account_key: string;
  status: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  records_considered: number;
  records_created: number;
  records_updated: number;
  records_unchanged: number;
  records_failed: number;
  error_code: string | null;
  error_message: string | null;
};

type ConnectorRecordRow = {
  id: string;
  connector_id: string;
  provider: string;
  entity_kind: string;
  entity_id: string;
  remote_id: string;
  remote_url: string | null;
  content_hash: string;
  last_pushed_at: string;
};

type Bindable = string | number | null;

function mapConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    provider: row.provider as ConnectorProvider,
    accountKey: row.account_key,
    displayName: row.display_name,
    status: row.status as ConnectorStatus,
    credentials: parseJsonColumn<ConnectorCredentials>(row.credentials),
    config: parseJsonColumn<ConnectorConfig>(row.config),
    lastConnectedAt: row.last_connected_at,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSyncRun(row: SyncRunRow): ConnectorSyncRun {
  return {
    id: row.id,
    connectorId: row.connector_id,
    provider: row.provider as ConnectorProvider,
    accountKey: row.account_key,
    status: row.status as ConnectorSyncRunStatus,
    trigger: row.trigger as ConnectorSyncTrigger,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    recordsConsidered: Number(row.records_considered),
    recordsCreated: Number(row.records_created),
    recordsUpdated: Number(row.records_updated),
    recordsUnchanged: Number(row.records_unchanged),
    recordsFailed: Number(row.records_failed),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function mapRecord(row: ConnectorRecordRow): ConnectorRecord {
  return {
    id: row.id,
    connectorId: row.connector_id,
    provider: row.provider as ConnectorProvider,
    entityKind: row.entity_kind as ConnectorEntityKind,
    entityId: row.entity_id,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    contentHash: row.content_hash,
    lastPushedAt: row.last_pushed_at,
  };
}

const UPSERT_CONNECTOR_SQL = `
INSERT INTO connectors (
  id, provider, account_key, display_name, status, credentials, config,
  last_connected_at, last_error, created_at, updated_at
) VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, NULL, ?, ?)
ON CONFLICT(provider, account_key) DO UPDATE SET
  display_name = COALESCE(excluded.display_name, connectors.display_name),
  status = 'connected',
  credentials = COALESCE(excluded.credentials, connectors.credentials),
  config = COALESCE(excluded.config, connectors.config),
  last_connected_at = excluded.last_connected_at,
  last_error = NULL,
  updated_at = excluded.updated_at`;

const UPSERT_RECORD_SQL = `
INSERT INTO connector_records (
  id, connector_id, provider, entity_kind, entity_id, remote_id, remote_url,
  content_hash, last_pushed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_id, entity_kind, entity_id) DO UPDATE SET
  provider = excluded.provider,
  remote_id = excluded.remote_id,
  remote_url = excluded.remote_url,
  content_hash = excluded.content_hash,
  last_pushed_at = excluded.last_pushed_at`;

export function createConnectorsRepo(db: Db): ConnectorsRepo {
  const get = (id: string): Connector | null => {
    const row = db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapConnector(row as ConnectorRow) : null;
  };

  const getSyncRun = (id: string): ConnectorSyncRun | null => {
    const row = db
      .prepare("SELECT * FROM connector_sync_runs WHERE id = ?")
      .get(id) as unknown | undefined;
    return row ? mapSyncRun(row as SyncRunRow) : null;
  };

  const readRecords = (connectorId: string): Map<string, ConnectorRecord> => {
    const rows = db
      .prepare("SELECT * FROM connector_records WHERE connector_id = ?")
      .all(connectorId) as unknown as ConnectorRecordRow[];
    const known = new Map<string, ConnectorRecord>();
    for (const row of rows) {
      known.set(`${row.entity_kind}:${row.entity_id}`, mapRecord(row));
    }
    return known;
  };

  return {
    get,

    getByProvider(provider, accountKey = "default") {
      const row = db
        .prepare(
          "SELECT * FROM connectors WHERE provider = ? AND account_key = ?",
        )
        .get(provider, accountKey) as unknown | undefined;
      return row ? mapConnector(row as ConnectorRow) : null;
    },

    list() {
      const rows = db
        .prepare(
          "SELECT * FROM connectors ORDER BY provider ASC, account_key ASC",
        )
        .all() as unknown as ConnectorRow[];
      return rows.map(mapConnector);
    },

    toSummary(connector) {
      // A refresh token must never be able to reach the browser, so the client
      // shape drops the field instead of masking it — a masked string still
      // travels, and one careless log line later it is in a bug report.
      const { credentials, ...rest } = connector;
      return { ...rest, hasCredentials: credentials !== null };
    },

    upsertConnected(input) {
      const accountKey = input.accountKey ?? "default";
      const stamp = nowIso();
      db.prepare(UPSERT_CONNECTOR_SQL).run(
        randomUUID(),
        input.provider,
        accountKey,
        input.displayName ?? null,
        input.credentials === undefined || input.credentials === null
          ? null
          : JSON.stringify(input.credentials),
        input.config === undefined || input.config === null
          ? null
          : JSON.stringify(input.config),
        stamp,
        stamp,
        stamp,
      );

      const row = db
        .prepare(
          "SELECT * FROM connectors WHERE provider = ? AND account_key = ?",
        )
        .get(input.provider, accountKey) as unknown | undefined;
      if (!row) {
        throw notFound(`Connector ${input.provider}/${accountKey} vanished.`);
      }
      return mapConnector(row as ConnectorRow);
    },

    updateState(input) {
      const assignments: string[] = [];
      const params: Bindable[] = [];
      // Three or more fields need the same pair-wise push, and `undefined`
      // means "leave alone" while `null` means "clear".
      const set = (column: string, value: Bindable) => {
        assignments.push(`${column} = ?`);
        params.push(value);
      };

      if (input.status !== undefined) set("status", input.status);
      if (input.credentials !== undefined) {
        set(
          "credentials",
          input.credentials === null ? null : JSON.stringify(input.credentials),
        );
      }
      if (input.config !== undefined) {
        set(
          "config",
          input.config === null ? null : JSON.stringify(input.config),
        );
      }
      if (input.displayName !== undefined) {
        set("display_name", input.displayName);
      }
      if (input.lastConnectedAt !== undefined) {
        set("last_connected_at", input.lastConnectedAt);
      }
      if (input.lastSyncedAt !== undefined) {
        set("last_synced_at", input.lastSyncedAt);
      }
      if (input.lastError !== undefined) set("last_error", input.lastError);

      set("updated_at", nowIso());
      params.push(input.id);

      const result = db
        .prepare(`UPDATE connectors SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...params);
      return result.changes === 0 ? null : get(input.id);
    },

    disconnect(id) {
      const result = db
        .prepare(
          `UPDATE connectors
             SET status = 'disconnected', credentials = NULL, last_error = NULL,
                 updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso(), id);
      return result.changes === 0 ? null : get(id);
    },

    startSyncRun(input) {
      const run: ConnectorSyncRun = {
        id: randomUUID(),
        connectorId: input.connectorId,
        provider: input.provider,
        accountKey: input.accountKey ?? "default",
        status: "running",
        trigger: input.trigger ?? "manual",
        startedAt: nowIso(),
        completedAt: null,
        recordsConsidered: 0,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsUnchanged: 0,
        recordsFailed: 0,
        errorCode: null,
        errorMessage: null,
      };

      db.prepare(
        `INSERT INTO connector_sync_runs
           (id, connector_id, provider, account_key, status, trigger, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.connectorId,
        run.provider,
        run.accountKey,
        run.status,
        run.trigger,
        run.startedAt,
      );
      return run;
    },

    finishSyncRun(input) {
      const result = db
        .prepare(
          `UPDATE connector_sync_runs
             SET status = ?, completed_at = ?, records_considered = ?,
                 records_created = ?, records_updated = ?, records_unchanged = ?,
                 records_failed = ?, error_code = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          nowIso(),
          input.recordsConsidered ?? 0,
          input.recordsCreated ?? 0,
          input.recordsUpdated ?? 0,
          input.recordsUnchanged ?? 0,
          input.recordsFailed ?? 0,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.id,
        );
      return result.changes === 0 ? null : getSyncRun(input.id);
    },

    listSyncRuns(filter = {}) {
      const clauses: string[] = [];
      const params: Bindable[] = [];
      if (filter.connectorId) {
        clauses.push("connector_id = ?");
        params.push(filter.connectorId);
      }
      if (filter.provider) {
        clauses.push("provider = ?");
        params.push(filter.provider);
      }
      if (filter.accountKey) {
        clauses.push("account_key = ?");
        params.push(filter.accountKey);
      }

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      let sql = `SELECT * FROM connector_sync_runs${where} ORDER BY started_at DESC, rowid DESC`;
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(filter.limit);
      }

      const rows = db.prepare(sql).all(...params) as unknown as SyncRunRow[];
      return rows.map(mapSyncRun);
    },

    getRecords: readRecords,

    upsertRecords(connectorId, entries) {
      if (entries.length === 0) return [];

      const connector = get(connectorId);
      if (!connector) throw notFound(`Connector ${connectorId} not found.`);

      const writeBatch = (): ConnectorRecord[] => {
        const upsert = db.prepare(UPSERT_RECORD_SQL);
        const stamp = nowIso();
        for (const entry of entries) {
          upsert.run(
            randomUUID(),
            connectorId,
            connector.provider,
            entry.entityKind,
            entry.entityId,
            entry.remoteId,
            entry.remoteUrl ?? null,
            entry.contentHash,
            stamp,
          );
        }

        // Re-read rather than echo the inputs: on conflict the row keeps its
        // original `id`, so the generated one above is not what was stored.
        const stored = readRecords(connectorId);
        const written: ConnectorRecord[] = [];
        for (const entry of entries) {
          const record = stored.get(`${entry.entityKind}:${entry.entityId}`);
          if (record) written.push(record);
        }
        return written;
      };

      // Reentrant: a push records rows and finishes a sync run together, so
      // the caller may already hold a transaction; nested BEGIN is an error.
      return db.isTransaction ? writeBatch() : transaction(db, writeBatch);
    },
  };
}
