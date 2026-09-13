import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApplicationOutcome,
  ApplicationStage,
  Interview,
  InterviewType,
  ResumeLink,
  ResumeLinkClick,
  StageEvent,
  Task,
  TaskType,
} from "@domain";
import {
  type Db,
  fromSqliteBool,
  nowIso,
  toSqliteBool,
  transaction,
} from "@server/db";

export type StagesRepo = {
  /** Newest first, matching `idx_stage_events_job`. */
  listForJob(jobId: string): StageEvent[];
  latestStageByJob(): Map<string, ApplicationStage>;
  append(input: {
    jobId: string;
    toStage: ApplicationStage;
    outcome?: ApplicationOutcome | null;
    note?: string | null;
  }): StageEvent;
};

export type InterviewsRepo = {
  list(): Interview[];
  listForJob(jobId: string): Interview[];
  create(input: Omit<Interview, "id">): Interview;
};

export type TaskFilter = { type?: TaskType; openOnly?: boolean };

export type TasksRepo = {
  list(filter?: TaskFilter): Task[];
  create(input: Omit<Task, "id">): Task;
  complete(id: string): Task | null;
};

export type ResumeLinkViewStats = {
  views: number;
  lastViewedAt: string | null;
};

export type ResumeLinksRepo = {
  create(input: {
    jobId: string;
    label: string;
    destinationUrl: string;
  }): ResumeLink;
  getByToken(token: string): ResumeLink | null;
  /** Oldest first, so a re-render reuses the token it minted the first time. */
  listForJob(jobId: string): ResumeLink[];
  recordClick(input: {
    linkId: string;
    isLikelyBot: boolean;
    userAgent: string | null;
  }): ResumeLinkClick;
  viewStatsByJob(): Map<string, ResumeLinkViewStats>;
};

type StageEventRow = {
  id: string;
  job_id: string;
  from_stage: string | null;
  to_stage: string;
  outcome: string | null;
  note: string | null;
  occurred_at: string;
};

type InterviewRow = {
  id: string;
  job_id: string;
  scheduled_at: string;
  duration_mins: number | null;
  type: string;
  outcome: string | null;
  notes: string | null;
};

type TaskRow = {
  id: string;
  job_id: string;
  type: string;
  title: string;
  due_at: string | null;
  is_completed: number;
  reason: string | null;
};

type ResumeLinkRow = {
  id: string;
  job_id: string;
  token: string;
  label: string;
  destination_url: string;
};

function mapStageEvent(row: StageEventRow): StageEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    fromStage: row.from_stage as ApplicationStage | null,
    toStage: row.to_stage as ApplicationStage,
    outcome: row.outcome as ApplicationOutcome | null,
    note: row.note,
    occurredAt: row.occurred_at,
  };
}

function mapInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    jobId: row.job_id,
    scheduledAt: row.scheduled_at,
    durationMins: row.duration_mins === null ? null : Number(row.duration_mins),
    type: row.type as InterviewType,
    outcome: row.outcome,
    notes: row.notes,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type as TaskType,
    title: row.title,
    dueAt: row.due_at,
    isCompleted: fromSqliteBool(row.is_completed) ?? false,
    reason: row.reason,
  };
}

function mapResumeLink(row: ResumeLinkRow): ResumeLink {
  return {
    id: row.id,
    jobId: row.job_id,
    token: row.token,
    label: row.label,
    destinationUrl: row.destination_url,
  };
}

const STAGE_ORDER = "occurred_at DESC, rowid DESC";

export function createStagesRepo(db: Db): StagesRepo {
  return {
    listForJob(jobId) {
      const rows = db
        .prepare(
          `SELECT * FROM stage_events WHERE job_id = ? ORDER BY ${STAGE_ORDER}`,
        )
        .all(jobId) as unknown as StageEventRow[];
      return rows.map(mapStageEvent);
    },

    latestStageByJob() {
      // One grouped pass, not a query per job: the dashboard reads this for
      // every tracked application at once. ROW_NUMBER rather than MAX() because
      // two events can share a millisecond, and an arbitrary winner among ties
      // would make the pipeline column flicker between renders.
      const rows = db
        .prepare(
          `SELECT job_id, to_stage FROM (
             SELECT job_id, to_stage,
                    ROW_NUMBER() OVER (
                      PARTITION BY job_id ORDER BY occurred_at DESC, rowid DESC
                    ) AS rn
             FROM stage_events
           ) WHERE rn = 1`,
        )
        .all() as unknown as Array<{ job_id: string; to_stage: string }>;

      const latest = new Map<string, ApplicationStage>();
      for (const row of rows) {
        latest.set(row.job_id, row.to_stage as ApplicationStage);
      }
      return latest;
    },

    append(input) {
      const write = (): StageEvent => {
        const previous = db
          .prepare(
            `SELECT to_stage FROM stage_events WHERE job_id = ? ORDER BY ${STAGE_ORDER} LIMIT 1`,
          )
          .get(input.jobId) as unknown as { to_stage: string } | undefined;

        const event: StageEvent = {
          id: randomUUID(),
          jobId: input.jobId,
          fromStage: (previous?.to_stage as ApplicationStage) ?? null,
          toStage: input.toStage,
          outcome: input.outcome ?? null,
          note: input.note ?? null,
          occurredAt: nowIso(),
        };

        db.prepare(
          `INSERT INTO stage_events
             (id, job_id, from_stage, to_stage, outcome, note, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.id,
          event.jobId,
          event.fromStage,
          event.toStage,
          event.outcome,
          event.note,
          event.occurredAt,
        );

        return event;
      };

      // Reentrant: transitioning a stage is usually one step of a larger
      // write the caller has already wrapped, and SQLite rejects nested BEGIN.
      return db.isTransaction ? write() : transaction(db, write);
    },
  };
}

export function createInterviewsRepo(db: Db): InterviewsRepo {
  return {
    list() {
      const rows = db
        .prepare(
          "SELECT * FROM interviews ORDER BY scheduled_at ASC, rowid ASC",
        )
        .all() as unknown as InterviewRow[];
      return rows.map(mapInterview);
    },

    listForJob(jobId) {
      const rows = db
        .prepare(
          "SELECT * FROM interviews WHERE job_id = ? ORDER BY scheduled_at ASC, rowid ASC",
        )
        .all(jobId) as unknown as InterviewRow[];
      return rows.map(mapInterview);
    },

    create(input) {
      const interview: Interview = { id: randomUUID(), ...input };
      db.prepare(
        `INSERT INTO interviews
           (id, job_id, scheduled_at, duration_mins, type, outcome, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        interview.id,
        interview.jobId,
        interview.scheduledAt,
        interview.durationMins,
        interview.type,
        interview.outcome,
        interview.notes,
      );
      return interview;
    },
  };
}

export function createTasksRepo(db: Db): TasksRepo {
  const get = (id: string): Task | null => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapTask(row as TaskRow) : null;
  };

  return {
    list(filter = {}) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.type) {
        clauses.push("type = ?");
        params.push(filter.type);
      }
      if (filter.openOnly) clauses.push("is_completed = 0");

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      // Dated work first, soonest due at the top; undated tasks sink to the
      // bottom instead of leading the queue as NULLs would by default.
      const rows = db
        .prepare(
          `SELECT * FROM tasks${where} ORDER BY (due_at IS NULL), due_at ASC, rowid ASC`,
        )
        .all(...params) as unknown as TaskRow[];
      return rows.map(mapTask);
    },

    create(input) {
      const task: Task = { id: randomUUID(), ...input };
      db.prepare(
        `INSERT INTO tasks (id, job_id, type, title, due_at, is_completed, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.jobId,
        task.type,
        task.title,
        task.dueAt,
        toSqliteBool(task.isCompleted) ?? 0,
        task.reason,
      );
      return task;
    },

    complete(id) {
      const result = db
        .prepare("UPDATE tasks SET is_completed = 1 WHERE id = ?")
        .run(id);
      return result.changes === 0 ? null : get(id);
    },
  };
}

export function createResumeLinksRepo(db: Db): ResumeLinksRepo {
  return {
    create(input) {
      const link: ResumeLink = {
        id: randomUUID(),
        jobId: input.jobId,
        // The token is the whole access control on the redirect: it is public,
        // so it has to be unguessable rather than sequential.
        token: randomBytes(12).toString("base64url"),
        label: input.label,
        destinationUrl: input.destinationUrl,
      };
      db.prepare(
        `INSERT INTO resume_links (id, job_id, token, label, destination_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        link.id,
        link.jobId,
        link.token,
        link.label,
        link.destinationUrl,
        nowIso(),
      );
      return link;
    },

    getByToken(token) {
      const row = db
        .prepare("SELECT * FROM resume_links WHERE token = ?")
        .get(token) as unknown | undefined;
      return row ? mapResumeLink(row as ResumeLinkRow) : null;
    },

    listForJob(jobId) {
      const rows = db
        .prepare(
          "SELECT * FROM resume_links WHERE job_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(jobId) as unknown as ResumeLinkRow[];
      return rows.map(mapResumeLink);
    },

    recordClick(input) {
      const click: ResumeLinkClick = {
        id: randomUUID(),
        linkId: input.linkId,
        clickedAt: nowIso(),
        isLikelyBot: input.isLikelyBot,
        userAgent: input.userAgent,
      };
      db.prepare(
        `INSERT INTO resume_link_clicks (id, link_id, clicked_at, is_likely_bot, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        click.id,
        click.linkId,
        click.clickedAt,
        toSqliteBool(click.isLikelyBot) ?? 0,
        click.userAgent,
      );
      return click;
    },

    viewStatsByJob() {
      // Bot filtering is the entire signal. Scanners and link-preview fetchers
      // open a tracked link within seconds of the mail leaving, so counting them
      // would report "they read it" for every application and fire the
      // follow-up cadence before a human ever looked.
      //
      // Inner join: a job whose only clicks are bots has no views, so it stays
      // out of the map rather than appearing with a zero.
      const rows = db
        .prepare(
          `SELECT l.job_id AS job_id,
                  COUNT(c.id) AS views,
                  MAX(c.clicked_at) AS last_viewed_at
           FROM resume_links l
           JOIN resume_link_clicks c
             ON c.link_id = l.id AND c.is_likely_bot = 0
           GROUP BY l.job_id`,
        )
        .all() as unknown as Array<{
        job_id: string;
        views: number;
        last_viewed_at: string | null;
      }>;

      const stats = new Map<string, ResumeLinkViewStats>();
      for (const row of rows) {
        stats.set(row.job_id, {
          views: Number(row.views),
          lastViewedAt: row.last_viewed_at,
        });
      }
      return stats;
    },
  };
}
