import type { ResumeTemplate, ResumeTemplateId } from "@domain";
import { request } from "@web/lib/api";

/**
 * The template half of the profile screen: what can be picked, what is picked,
 * and the URL that renders the saved profile through one of them.
 *
 * The preview is a plain URL rather than a fetch because a PDF belongs in the
 * browser's own viewer — an `<iframe>` or a new tab both render it without this
 * app shipping a PDF renderer. `at` busts the viewer's cache after a save, so a
 * preview never shows the profile as it was two edits ago.
 */

export type ResumeTemplatesResponse = {
  templates: ResumeTemplate[];
  selected: ResumeTemplateId;
};

export function fetchResumeTemplates(
  signal?: AbortSignal,
): Promise<ResumeTemplatesResponse> {
  return request<ResumeTemplatesResponse>(
    "/api/resume/templates",
    signal ? { signal } : undefined,
  );
}

export function selectResumeTemplate(
  template: ResumeTemplateId,
  signal?: AbortSignal,
): Promise<{ selected: ResumeTemplateId }> {
  return request<{ selected: ResumeTemplateId }>("/api/resume/template", {
    method: "PUT",
    body: JSON.stringify({ template }),
    ...(signal ? { signal } : {}),
  });
}

export function resumePreviewUrl(
  template: ResumeTemplateId,
  at: number,
): string {
  return `/api/resume/preview.pdf?template=${encodeURIComponent(template)}&at=${at}`;
}
