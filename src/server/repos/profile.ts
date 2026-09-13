import type {
  ProfileCompleteness,
  ProfileDraft,
  ProfileEducation,
  ProfileLink,
  ProfileProject,
  ProfileRole,
  RoleSuggestion,
  RoleSuggestionSet,
  SkillGroup,
} from "@domain";
import { type Db, nowIso, parseJsonColumn } from "@server/db";
import { isFilled, profileCompleteness } from "@server/profile/completeness";
import { ensureProfileSchema } from "@server/profile/schema";

/** Single-user app: one profile, one id. */
export const PROFILE_ID = "primary";

export type ProfileRepo = {
  get(): ProfileDraft | null;
  put(draft: ProfileDraft): ProfileDraft;
  /** What the resume pipeline still needs before it can run on this draft. */
  completeness(draft: ProfileDraft): ProfileCompleteness;
  /** The stored suggestion set, whatever profile state it was drawn from. */
  getSuggestions(): RoleSuggestionSet | null;
  putSuggestions(set: RoleSuggestionSet): RoleSuggestionSet;
};

type ProfileRow = {
  name: string;
  headline: string;
  email: string;
  phone: string | null;
  location: string | null;
  summary: string;
  links: string;
  skills: string;
  roles: string;
  projects: string;
  education: string;
};

type SuggestionRow = {
  fingerprint: string;
  model: string;
  suggestions: string;
  generated_at: string;
};

const trimOrNull = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Trim on the way in, once. Every downstream consumer — the renderer, the fact
 * gate, the completeness check — would otherwise have to decide for itself
 * whether " " counts as a value.
 */
function normalize(draft: ProfileDraft): ProfileDraft {
  return {
    name: draft.name.trim(),
    headline: draft.headline.trim(),
    email: draft.email.trim(),
    phone: trimOrNull(draft.phone),
    location: trimOrNull(draft.location),
    summary: draft.summary.trim(),
    links: draft.links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.url !== ""),
    skills: draft.skills
      .map((group) => ({
        name: group.name.trim(),
        keywords: group.keywords.map((word) => word.trim()).filter(isFilled),
      }))
      .filter((group) => group.name !== "" || group.keywords.length > 0),
    roles: draft.roles
      .map((role) => ({
        company: role.company.trim(),
        title: role.title.trim(),
        location: trimOrNull(role.location),
        startDate: trimOrNull(role.startDate),
        endDate: trimOrNull(role.endDate),
        bullets: role.bullets.map((bullet) => bullet.trim()).filter(isFilled),
      }))
      .filter((role) => role.company !== "" || role.title !== ""),
    projects: draft.projects
      .map((project) => ({
        name: project.name.trim(),
        description: project.description.trim(),
        url: trimOrNull(project.url),
        bullets: project.bullets
          .map((bullet) => bullet.trim())
          .filter(isFilled),
      }))
      .filter((project) => project.name !== ""),
    education: draft.education
      .map((entry) => ({
        school: entry.school.trim(),
        credential: trimOrNull(entry.credential),
        location: trimOrNull(entry.location),
        startDate: trimOrNull(entry.startDate),
        endDate: trimOrNull(entry.endDate),
      }))
      .filter((entry) => entry.school !== ""),
  };
}

function mapRow(row: ProfileRow): ProfileDraft {
  return {
    name: row.name,
    headline: row.headline,
    email: row.email,
    phone: row.phone,
    location: row.location,
    summary: row.summary,
    links: parseJsonColumn<ProfileLink[]>(row.links) ?? [],
    skills: parseJsonColumn<SkillGroup[]>(row.skills) ?? [],
    roles: parseJsonColumn<ProfileRole[]>(row.roles) ?? [],
    projects: parseJsonColumn<ProfileProject[]>(row.projects) ?? [],
    education: parseJsonColumn<ProfileEducation[]>(row.education) ?? [],
  };
}

export function createProfileRepo(db: Db): ProfileRepo {
  ensureProfileSchema(db);

  return {
    get() {
      const row = db
        .prepare(
          `SELECT name, headline, email, phone, location, summary,
                  links, skills, roles, projects, education
             FROM profile WHERE id = ?`,
        )
        .get(PROFILE_ID) as unknown as ProfileRow | undefined;
      return row ? mapRow(row) : null;
    },

    put(draft) {
      const clean = normalize(draft);
      db.prepare(
        `INSERT INTO profile
           (id, name, headline, email, phone, location, summary,
            links, skills, roles, projects, education, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           headline = excluded.headline,
           email = excluded.email,
           phone = excluded.phone,
           location = excluded.location,
           summary = excluded.summary,
           links = excluded.links,
           skills = excluded.skills,
           roles = excluded.roles,
           projects = excluded.projects,
           education = excluded.education,
           updated_at = excluded.updated_at`,
      ).run(
        PROFILE_ID,
        clean.name,
        clean.headline,
        clean.email,
        clean.phone,
        clean.location,
        clean.summary,
        JSON.stringify(clean.links),
        JSON.stringify(clean.skills),
        JSON.stringify(clean.roles),
        JSON.stringify(clean.projects),
        JSON.stringify(clean.education),
        nowIso(),
      );
      return clean;
    },

    completeness: profileCompleteness,

    getSuggestions() {
      const row = db
        .prepare(
          `SELECT fingerprint, model, suggestions, generated_at
             FROM profile_role_suggestions WHERE profile_id = ?`,
        )
        .get(PROFILE_ID) as unknown as SuggestionRow | undefined;
      if (!row) return null;
      return {
        suggestions: parseJsonColumn<RoleSuggestion[]>(row.suggestions) ?? [],
        fingerprint: row.fingerprint,
        model: row.model,
        generatedAt: row.generated_at,
      };
    },

    putSuggestions(set) {
      db.prepare(
        `INSERT INTO profile_role_suggestions
           (profile_id, fingerprint, model, suggestions, generated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           model = excluded.model,
           suggestions = excluded.suggestions,
           generated_at = excluded.generated_at`,
      ).run(
        PROFILE_ID,
        set.fingerprint,
        set.model,
        JSON.stringify(set.suggestions),
        set.generatedAt,
      );
      return set;
    },
  };
}
