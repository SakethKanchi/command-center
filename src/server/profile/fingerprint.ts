/**
 * A digest of the profile facts that role suggestions are derived from.
 *
 * Suggestions cost a model call, so they are stored rather than regenerated on
 * every page load — and a stored suggestion is only honest while the profile
 * it was drawn from is unchanged. Hashing the *inputs* rather than the whole
 * draft is the point: correcting a phone number must not throw away a good set
 * of suggestions, and adding a role must.
 */

import { createHash } from "node:crypto";
import type { ProfileDraft } from "@domain";

export function profileFingerprint(draft: ProfileDraft): string {
  const material = JSON.stringify([
    draft.headline,
    draft.summary,
    draft.location,
    draft.skills.map((group) => [group.name, group.keywords]),
    draft.roles.map((role) => [
      role.title,
      role.company,
      role.startDate,
      role.endDate,
      role.bullets,
    ]),
    draft.projects.map((project) => [
      project.name,
      project.description,
      project.bullets,
    ]),
    draft.education.map((entry) => [
      entry.credential,
      entry.school,
      entry.endDate,
    ]),
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
