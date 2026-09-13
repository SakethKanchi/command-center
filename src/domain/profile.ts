/**
 * The editable candidate profile.
 *
 * `Profile` (in `./jobs`) is what the resume renderer and the fabrication gate
 * consume: validated, complete, and non-negotiable. `ProfileDraft` is what a
 * human — or a resume parser — is allowed to hand us: the same facts, but
 * every field permitted to be empty while it is still being filled in. The two
 * are deliberately separate types so that "half-typed" can never be mistaken
 * for "ready to render", and `ProfileCompleteness` is the bridge that says
 * which one you are holding.
 */

import type { SkillGroup } from "./jobs";

export type ProfileLink = { label: string; url: string };

export type ProfileRole = {
  company: string;
  title: string;
  location: string | null;
  /** "2024-03" or an ISO date. Free text is tolerated: resumes say "Mar 2024". */
  startDate: string | null;
  /** `null` means current. */
  endDate: string | null;
  bullets: string[];
};

export type ProfileEducation = {
  school: string;
  credential: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
};

/**
 * Side projects, open source, coursework — work with no employer attached.
 *
 * Same shape as `Profile["projects"]` so the render mapping is a copy rather
 * than a translation, and `url` is nullable because plenty of good projects
 * are not public.
 */
export type ProfileProject = {
  name: string;
  description: string;
  url: string | null;
  bullets: string[];
};

export type ProfileDraft = {
  name: string;
  headline: string;
  email: string;
  phone: string | null;
  location: string | null;
  links: ProfileLink[];
  summary: string;
  skills: SkillGroup[];
  roles: ProfileRole[];
  projects: ProfileProject[];
  education: ProfileEducation[];
};

/** What is still missing before the resume pipeline can run cleanly. */
export type ProfileCompleteness = {
  score: number;
  missing: string[];
  ready: boolean;
};

/**
 * A role the profile is already qualified for, phrased the way a job board
 * phrases it, plus the search that finds it.
 *
 * `query` exists separately from `title` because the two answer to different
 * things: the title is what the user reads, the query is what the corpus
 * search and the board adapters actually match on, and the shortest text that
 * finds a role is rarely its full title ("Machine Learning Engineer" finds
 * more than "Machine Learning Engineer II, Ranking").
 */
export type RoleSuggestion = {
  title: string;
  query: string;
  /** One sentence, traced to something the profile states. */
  reason: string;
};

/**
 * A generated set plus the profile state it was generated from. The
 * fingerprint is what makes staleness a fact rather than a guess: edit the
 * resume and the stored set no longer describes the profile on file.
 */
export type RoleSuggestionSet = {
  suggestions: RoleSuggestion[];
  fingerprint: string;
  model: string;
  generatedAt: string;
};

/**
 * A draft with nothing in it. Every "start from scratch" path — the profile
 * editor, an import that found no text — starts here rather than from a
 * hand-built literal, so adding a field cannot leave one caller short.
 */
export function emptyProfileDraft(): ProfileDraft {
  return {
    name: "",
    headline: "",
    email: "",
    phone: null,
    location: null,
    links: [],
    summary: "",
    skills: [],
    roles: [],
    projects: [],
    education: [],
  };
}

export function blankProfileRole(): ProfileRole {
  return {
    company: "",
    title: "",
    location: null,
    startDate: null,
    endDate: null,
    bullets: [],
  };
}

export function blankProfileProject(): ProfileProject {
  return {
    name: "",
    description: "",
    url: null,
    bullets: [],
  };
}

export function blankProfileEducation(): ProfileEducation {
  return {
    school: "",
    credential: null,
    location: null,
    startDate: null,
    endDate: null,
  };
}
