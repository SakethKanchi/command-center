/**
 * The resume templates a user may pick between.
 *
 * The catalogue lives in `@domain` rather than next to the `.typ` files because
 * three separate places need the same list: the renderer resolves an id to a
 * file, the API validates what the client sent, and the picker renders the
 * labels. A template is therefore an id plus the two sentences a user needs to
 * choose one — not a preview image, because every template here is deliberately
 * the same single-column document with different typography, and a thumbnail
 * would oversell the difference.
 *
 * Every template compiles the same profile through the same body in
 * `server/resume/templates/common.typ`. That is the constraint, not a shortcut:
 * the fabrication gate compares extracted PDF text against the profile byte for
 * byte, and the ATS gate halts a run below 70/100, so a template that reorders
 * sections or introduces a sidebar would fail the pipeline rather than produce a
 * prettier resume.
 */

export const RESUME_TEMPLATES = [
  {
    id: "ats",
    label: "ATS baseline",
    description:
      "Arial-metric sans, centred header, ruled section headings. The safest thing to put through an automated parser.",
  },
  {
    id: "compact",
    label: "Compact",
    description:
      "Same sans, tighter margins and leading, left-aligned header. Use it when a long history is spilling onto a second page.",
  },
  {
    id: "classic",
    label: "Classic serif",
    description:
      "Times-metric serif with a larger name and letterspaced headings. Reads as a traditional CV for finance, law and academia.",
  },
] as const;

export type ResumeTemplate = (typeof RESUME_TEMPLATES)[number];
export type ResumeTemplateId = ResumeTemplate["id"];

/** What renders when nobody has chosen: the most parser-safe of the three. */
export const DEFAULT_RESUME_TEMPLATE: ResumeTemplateId = "ats";

export function isResumeTemplateId(value: unknown): value is ResumeTemplateId {
  return RESUME_TEMPLATES.some((template) => template.id === value);
}
