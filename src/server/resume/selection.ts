/**
 * Which template this installation renders with.
 *
 * One choice, stored in `settings`, not one per job: the template is a
 * presentation preference for the candidate, and a per-job override would mean
 * the agent silently changed how a resume looked between two applications. The
 * render call still takes an explicit id, so a preview can show a template
 * before it is chosen without writing anything.
 */

import {
  DEFAULT_RESUME_TEMPLATE,
  isResumeTemplateId,
  type ResumeTemplateId,
} from "@domain";
import type { SettingsRepo } from "@server/repos";

export const RESUME_TEMPLATE_SETTING = "resume.template";

/**
 * A stored id that is no longer in the catalogue reads as the default rather
 * than as an error: a template removed in a later version must not break every
 * subsequent run for someone who had picked it.
 */
export function selectedResumeTemplate(
  settings: SettingsRepo,
): ResumeTemplateId {
  const stored = settings.get(RESUME_TEMPLATE_SETTING);
  return isResumeTemplateId(stored) ? stored : DEFAULT_RESUME_TEMPLATE;
}
