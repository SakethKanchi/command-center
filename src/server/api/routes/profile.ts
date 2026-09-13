/**
 * Candidate-profile endpoints.
 *
 * The profile is the source of truth for resume tailoring and for the
 * fabrication gate, which is why the three verbs here are deliberately
 * separate: `GET` reads whichever source answered, `PUT` is the only thing
 * that writes, and `POST /profile/import` parses an uploaded file into a draft
 * and returns it *without saving*. Import is a proposal a human confirms — a
 * parser writing straight into the gate's evidence would be the fabrication
 * hazard the gate exists to stop.
 */

import type { ProfileDraft } from "@domain";
import type { ApiDeps } from "@server/api/app";
import { ok } from "@server/api/respond";
import { badRequest } from "@server/infra/errors";
import {
  draftFromResumeText,
  extractResumeText,
  profileCompleteness,
  profileToDraft,
} from "@server/profile";
import { loadProfile } from "@server/resume/profile";
import { Hono } from "hono";
import { z } from "zod";

/**
 * Generous ceilings, not validation theatre. They exist so a runaway paste or
 * a hostile upload cannot put a megabyte of prose in a TEXT column; the shapes
 * themselves have to accept whatever an import produced, including every field
 * blank, or the import → review → save flow breaks on its own output.
 */
const LIMITS = {
  name: 200,
  headline: 300,
  summary: 4_000,
  short: 200,
  bullet: 1_000,
  links: 25,
  roles: 40,
  projects: 20,
  bullets: 40,
  skills: 30,
  keywords: 100,
  education: 20,
} as const;

/** An empty string and a missing value are the same "not filled in yet". */
const nullableShort = z
  .union([z.string().max(LIMITS.short), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  });

/** Same rule as `nullableShort`, with room for a URL. */
const nullableUrl = z
  .union([z.string().max(LIMITS.short * 2), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  });

const draftSchema = z.object({
  name: z.string().max(LIMITS.name),
  headline: z.string().max(LIMITS.headline),
  // Not `z.string().email()`: an import that found no address returns "", and
  // rejecting that would make the reviewed draft unsavable. A non-empty value
  // still has to look like an address.
  email: z
    .string()
    .max(LIMITS.short)
    .refine(
      (value) =>
        value.trim() === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
      { message: "must be an email address, or empty" },
    ),
  phone: nullableShort,
  location: nullableShort,
  summary: z.string().max(LIMITS.summary),
  links: z
    .array(
      z.object({
        label: z.string().max(LIMITS.short),
        url: z.string().max(LIMITS.short * 2),
      }),
    )
    .max(LIMITS.links),
  skills: z
    .array(
      z.object({
        name: z.string().max(LIMITS.short),
        keywords: z.array(z.string().max(LIMITS.short)).max(LIMITS.keywords),
      }),
    )
    .max(LIMITS.skills),
  roles: z
    .array(
      z.object({
        company: z.string().max(LIMITS.short),
        title: z.string().max(LIMITS.short),
        location: nullableShort,
        startDate: nullableShort,
        endDate: nullableShort,
        bullets: z.array(z.string().max(LIMITS.bullet)).max(LIMITS.bullets),
      }),
    )
    .max(LIMITS.roles),
  projects: z
    .array(
      z.object({
        name: z.string().max(LIMITS.short),
        description: z.string().max(LIMITS.short * 2),
        url: nullableUrl,
        bullets: z.array(z.string().max(LIMITS.bullet)).max(LIMITS.bullets),
      }),
    )
    .max(LIMITS.projects),
  education: z
    .array(
      z.object({
        school: z.string().max(LIMITS.short),
        credential: nullableShort,
        location: nullableShort,
        startDate: nullableShort,
        endDate: nullableShort,
      }),
    )
    .max(LIMITS.education),
});

/** `roles.2.bullets.0: too long` — the only form a user can act on. */
function parseDraft(value: unknown): ProfileDraft {
  const result = draftSchema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  throw badRequest(
    `Invalid profile: ${issues
      .map((issue) => `${issue.field} ${issue.message}`)
      .join("; ")}`,
    { issues, fields: issues.map((issue) => issue.field) },
  );
}

export function createProfileRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();

  routes.get("/profile", (c) => {
    const stored = deps.repos.profile.get();
    // The committed seed keeps a fresh clone renderable; it is a starting
    // point in the editor, not a saved profile, and `source` says so.
    const profile = stored ?? profileToDraft(loadProfile());
    return ok(c, {
      profile,
      source: stored === null ? "seed" : "stored",
      completeness: profileCompleteness(profile),
    });
  });

  routes.put("/profile", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("Profile body must be a JSON object.");
    }
    const profile = deps.repos.profile.put(parseDraft(body));
    return ok(c, { profile, completeness: profileCompleteness(profile) });
  });

  // Registered as its own path rather than a query flag on PUT: this one never
  // writes, and that difference should be visible in the URL.
  routes.post("/profile/import", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      throw badRequest(
        "Attach the resume as a multipart form field named `file`.",
        { received: Object.keys(body) },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractResumeText({ name: file.name, bytes });
    const { draft, warnings } = await draftFromResumeText(
      extracted.text,
      deps.llm,
    );

    return ok(c, {
      draft,
      warnings: [...extracted.warnings, ...warnings],
      extractedChars: extracted.text.length,
      fileName: file.name,
    });
  });

  return routes;
}
