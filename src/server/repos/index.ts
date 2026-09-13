/**
 * The only module that writes SQL.
 *
 * Everything above this layer — routes, connectors, the agent loop — takes a
 * `RepoBundle` and calls methods on it. Keeping the SQL behind one seam is what
 * lets a test open a throwaway database, build a bundle over it, and exercise
 * the real query plans with no mocks anywhere.
 *
 * Every method is synchronous: `node:sqlite` is a synchronous driver, and
 * wrapping it in promises would only add microtask hops and a false suggestion
 * that callers can interleave work mid-transaction.
 */

import { type Db, getDb } from "@server/db";
import { type AgentRepo, createAgentRepo } from "./agent";
import { type ConnectorsRepo, createConnectorsRepo } from "./connectors";
import { createJobsRepo, type JobsRepo } from "./jobs";
import { createProfileRepo, type ProfileRepo } from "./profile";
import { createSettingsRepo, type SettingsRepo } from "./settings";
import {
  createInterviewsRepo,
  createResumeLinksRepo,
  createStagesRepo,
  createTasksRepo,
  type InterviewsRepo,
  type ResumeLinksRepo,
  type StagesRepo,
  type TasksRepo,
} from "./tracking";

export type { AgentRepo, AgentRunFilter } from "./agent";
export type {
  ConnectorRecordInput,
  ConnectorsRepo,
  SyncRunFilter,
} from "./connectors";
export type { JobFilter, JobsRepo } from "./jobs";
export type { ProfileRepo } from "./profile";
export { PROFILE_ID } from "./profile";
export type { SettingsRepo } from "./settings";
export type {
  InterviewsRepo,
  ResumeLinksRepo,
  ResumeLinkViewStats,
  StagesRepo,
  TaskFilter,
  TasksRepo,
} from "./tracking";

export type RepoBundle = {
  jobs: JobsRepo;
  stages: StagesRepo;
  interviews: InterviewsRepo;
  tasks: TasksRepo;
  resumeLinks: ResumeLinksRepo;
  connectors: ConnectorsRepo;
  agent: AgentRepo;
  profile: ProfileRepo;
  settings: SettingsRepo;
  /** Exposed for `transaction(repos.db, ...)` across two repositories. */
  db: Db;
};

export function createRepos(db: Db = getDb()): RepoBundle {
  return {
    jobs: createJobsRepo(db),
    stages: createStagesRepo(db),
    interviews: createInterviewsRepo(db),
    tasks: createTasksRepo(db),
    resumeLinks: createResumeLinksRepo(db),
    connectors: createConnectorsRepo(db),
    agent: createAgentRepo(db),
    profile: createProfileRepo(db),
    settings: createSettingsRepo(db),
    db,
  };
}
