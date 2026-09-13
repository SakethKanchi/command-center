/**
 * Translation between the editable draft and the renderer's `Profile`.
 *
 * Two shapes exist because they answer to different masters: `ProfileDraft` is
 * whatever a human has typed so far, `Profile` is what the resume template and
 * the fabrication gate are allowed to see. Neither is derivable from the other
 * by accident, so the conversion is written out once, here, and the fields
 * that genuinely have no counterpart are commented rather than silently
 * dropped.
 */

import type { Profile, ProfileDraft } from "@domain";

/**
 * Render-ready view of a draft.
 *
 * Every field of `Profile` now has a draft counterpart, so this is a copy
 * rather than a translation with holes in it — the two places that still
 * differ (a role's start date, a credential) are commented where they happen.
 */
export function draftToProfile(draft: ProfileDraft): Profile {
  return {
    name: draft.name,
    email: draft.email,
    phone: draft.phone,
    location: draft.location,
    links: draft.links.map((link) => ({ label: link.label, url: link.url })),
    headline: draft.headline,
    summary: draft.summary,
    experience: draft.roles.map((role) => ({
      company: role.company,
      title: role.title,
      // The renderer always prints a date range, so "absent" is an empty
      // string here rather than a hole in the layout.
      start: role.startDate ?? "",
      end: role.endDate,
      location: role.location,
      bullets: [...role.bullets],
    })),
    projects: draft.projects.map((project) => ({
      name: project.name,
      description: project.description,
      url: project.url,
      bullets: [...project.bullets],
    })),
    skills: draft.skills.map((group) => ({
      name: group.name,
      keywords: [...group.keywords],
    })),
    education: draft.education.map((entry) => ({
      school: entry.school,
      degree: entry.credential ?? "",
      start: entry.startDate,
      end: entry.endDate,
    })),
  };
}

/**
 * Editable view of a validated profile, used to seed the editor from the
 * committed JSON on a machine that has never saved one.
 */
export function profileToDraft(profile: Profile): ProfileDraft {
  return {
    name: profile.name,
    headline: profile.headline,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    links: profile.links.map((link) => ({ label: link.label, url: link.url })),
    summary: profile.summary,
    skills: profile.skills.map((group) => ({
      name: group.name,
      keywords: [...group.keywords],
    })),
    projects: profile.projects.map((project) => ({
      name: project.name,
      description: project.description,
      url: project.url,
      bullets: [...project.bullets],
    })),
    roles: profile.experience.map((role) => ({
      company: role.company,
      title: role.title,
      location: role.location,
      startDate: role.start === "" ? null : role.start,
      endDate: role.end,
      bullets: [...role.bullets],
    })),
    education: profile.education.map((entry) => ({
      school: entry.school,
      credential: entry.degree === "" ? null : entry.degree,
      // The renderer's education rows carry no location; a draft round-tripped
      // through `Profile` cannot recover one it never stored.
      location: null,
      startDate: entry.start,
      endDate: entry.end,
    })),
  };
}
