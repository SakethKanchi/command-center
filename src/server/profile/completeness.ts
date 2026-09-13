/**
 * Whether a draft is allowed to reach the resume pipeline.
 *
 * This is not a progress bar dressed up as a type. The resume template prints
 * the name, headline and summary unconditionally, and the fabrication gate
 * measures every generated sentence against the roles and skills — so a draft
 * missing any of these produces either a resume with holes in it or a gate
 * that flags the candidate's real achievements as invented. `ready` is the
 * permission to render; `missing` is the list a user can act on.
 */

import type { ProfileCompleteness, ProfileDraft } from "@domain";

/** A field of whitespace is a field a human has not filled in. */
export function isFilled(value: string): boolean {
  return value.trim() !== "";
}

const REQUIREMENTS: Array<{
  /** Prefixed with the draft field so a UI can highlight it by name. */
  label: string;
  satisfied(draft: ProfileDraft): boolean;
}> = [
  { label: "name", satisfied: (draft) => isFilled(draft.name) },
  { label: "headline", satisfied: (draft) => isFilled(draft.headline) },
  { label: "email", satisfied: (draft) => isFilled(draft.email) },
  { label: "summary", satisfied: (draft) => isFilled(draft.summary) },
  {
    label: "roles: at least one role with at least one bullet",
    satisfied: (draft) =>
      draft.roles.some(
        (role) =>
          isFilled(role.company) &&
          isFilled(role.title) &&
          role.bullets.some(isFilled),
      ),
  },
  {
    label: "skills: at least one skill group with at least one keyword",
    satisfied: (draft) =>
      draft.skills.some(
        (group) => isFilled(group.name) && group.keywords.some(isFilled),
      ),
  },
];

/** Optional in the strict sense: absent costs score, never readiness. */
const NICE_TO_HAVES: Array<(draft: ProfileDraft) => boolean> = [
  (draft) => draft.location !== null && isFilled(draft.location),
  (draft) => draft.links.length > 0,
  (draft) => draft.education.length > 0,
];

/**
 * Requirements outweigh the extras, so a draft that can render never scores
 * below one that merely looks tidy.
 */
const REQUIRED_WEIGHT = 2;

export function profileCompleteness(draft: ProfileDraft): ProfileCompleteness {
  const total = REQUIREMENTS.length * REQUIRED_WEIGHT + NICE_TO_HAVES.length;
  let earned = 0;
  const missing: string[] = [];

  for (const requirement of REQUIREMENTS) {
    if (requirement.satisfied(draft)) earned += REQUIRED_WEIGHT;
    else missing.push(requirement.label);
  }
  for (const check of NICE_TO_HAVES) {
    if (check(draft)) earned += 1;
  }

  return {
    score: Math.round((earned / total) * 100),
    missing,
    ready: missing.length === 0,
  };
}
