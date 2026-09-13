/**
 * Resume template endpoints: what you can pick, what is picked, and the PDF.
 *
 * The render here is deliberately *not* the agent's render. The agent tailors a
 * resume to one posting and its output is evidence attached to that run; this
 * one rebuilds the untailored resume from the saved profile so a user can see
 * what a template does to their document before a job is ever involved. It
 * writes nothing except the settings row that records the choice — the PDF is
 * streamed from a temporary file and deleted, because a preview is not an
 * artifact anyone should be able to cite later.
 *
 * An incomplete profile is refused with the same missing-field list the profile
 * screen shows, rather than rendering a resume full of holes.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isResumeTemplateId,
  RESUME_TEMPLATES,
  type ResumeTemplateId,
} from "@domain";
import type { ApiDeps } from "@server/api/app";
import { ok } from "@server/api/respond";
import { badRequest } from "@server/infra/errors";
import {
  draftToProfile,
  profileCompleteness,
  profileToDraft,
} from "@server/profile";
import { loadProfile } from "@server/resume/profile";
import { renderResumePdf } from "@server/resume/render";
import {
  RESUME_TEMPLATE_SETTING,
  selectedResumeTemplate,
} from "@server/resume/selection";
import { Hono } from "hono";
import { z } from "zod";

const templateBody = z.object({
  template: z.custom<ResumeTemplateId>(isResumeTemplateId, {
    message: `template must be one of ${RESUME_TEMPLATES.map((entry) => entry.id).join(", ")}`,
  }),
});

/** Safe enough for a `filename=` and still recognisable in a downloads folder. */
function downloadName(name: string, template: string): string {
  const stem = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem === "" ? "resume" : stem}-${template}.pdf`;
}

export function createResumeRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();

  routes.get("/resume/templates", (c) =>
    ok(c, {
      templates: RESUME_TEMPLATES,
      selected: selectedResumeTemplate(deps.repos.settings),
    }),
  );

  routes.put("/resume/template", async (c) => {
    const body = templateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      throw badRequest(
        body.error.issues[0]?.message ?? "Invalid resume template.",
        { templates: RESUME_TEMPLATES.map((entry) => entry.id) },
      );
    }
    deps.repos.settings.set(RESUME_TEMPLATE_SETTING, body.data.template);
    return ok(c, { selected: body.data.template });
  });

  /**
   * The saved profile, rendered. `?template=` previews one without selecting
   * it; omitted, it renders the selection, which is what the agent would send.
   */
  routes.get("/resume/preview.pdf", async (c) => {
    const requested = c.req.query("template");
    if (requested !== undefined && !isResumeTemplateId(requested)) {
      throw badRequest(`Unknown resume template "${requested}".`, {
        templates: RESUME_TEMPLATES.map((entry) => entry.id),
      });
    }
    const template = requested ?? selectedResumeTemplate(deps.repos.settings);

    const stored = deps.repos.profile.get();
    const draft = stored ?? profileToDraft(loadProfile());
    const completeness = profileCompleteness(draft);
    if (!completeness.ready) {
      throw badRequest(
        "This profile is not complete enough to render a resume yet.",
        { missing: completeness.missing },
      );
    }

    const outputPath = path.join(
      tmpdir(),
      `command-center-preview-${randomUUID()}.pdf`,
    );
    try {
      const rendered = await renderResumePdf({
        profile: draftToProfile(draft),
        template,
        outputPath,
      });
      const pdf = await readFile(rendered.pdfPath);
      return c.body(
        new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength),
        200,
        {
          "content-type": "application/pdf",
          // `inline`: the picker shows it in a viewer, and a browser's own
          // download button still names the file sensibly.
          "content-disposition": `inline; filename="${downloadName(draft.name, template)}"`,
          "cache-control": "no-store",
          "x-resume-template": rendered.template,
          "x-resume-pages": String(rendered.pageCount),
        },
      );
    } finally {
      await rm(outputPath, { force: true });
    }
  });

  return routes;
}
