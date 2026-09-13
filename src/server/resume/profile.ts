/**
 * The candidate profile is the single source of truth every downstream check
 * measures generated copy against, so it is validated once, loudly, at load
 * time rather than trusted field by field at render time.
 *
 * Two sources answer, in order: the row the user saved through the profile
 * editor, then the committed `profile.json` seed. The seed exists so a fresh
 * clone renders a resume before anyone has typed anything; the moment a user
 * saves, their row wins for tailoring, rendering AND the fabrication gate.
 * Those three have to agree — a gate reading the seed would flag the user's
 * own real accomplishments as invented.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Profile, ProfileDraft } from "@domain";
import { badRequest } from "@server/infra/errors";
import { profileCompleteness } from "@server/profile/completeness";
import { draftToProfile } from "@server/profile/map";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
/** `null` is the domain's "not applicable"; an empty string never is. */
const nullableNonEmpty = nonEmpty.nullable();

const linkSchema = z.object({
  label: nonEmpty,
  url: z.string().url(),
});

const skillGroupSchema = z.object({
  name: nonEmpty,
  keywords: z.array(nonEmpty).min(1),
});

const profileSchema = z.object({
  name: nonEmpty,
  email: z.string().email(),
  phone: nullableNonEmpty,
  location: nullableNonEmpty,
  links: z.array(linkSchema),
  headline: nonEmpty,
  summary: nonEmpty,
  experience: z
    .array(
      z.object({
        company: nonEmpty,
        title: nonEmpty,
        start: nonEmpty,
        end: nullableNonEmpty,
        location: nullableNonEmpty,
        bullets: z.array(nonEmpty),
      }),
    )
    .min(1),
  projects: z.array(
    z.object({
      name: nonEmpty,
      description: z.string(),
      url: z.string().url().nullable(),
      bullets: z.array(nonEmpty),
    }),
  ),
  skills: z.array(skillGroupSchema).min(1),
  education: z.array(
    z.object({
      school: nonEmpty,
      degree: nonEmpty,
      start: nullableNonEmpty,
      end: nullableNonEmpty,
    }),
  ),
});

export const DEFAULT_PROFILE_PATH = fileURLToPath(
  new URL("./profile.json", import.meta.url),
);

/** Keyed by resolved path so a test fixture never shadows the real profile. */
const cache = new Map<string, Profile>();

/** `issues` rendered as `field: message`, which is what makes a bad edit fixable. */
function describeIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Read and validate the candidate profile. Parsed once per path: every render,
 * tailoring pass and fabrication check reads the same object.
 */
export function loadProfile(path: string = DEFAULT_PROFILE_PATH): Profile {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw badRequest(`Resume profile could not be read at ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw badRequest(`Resume profile at ${path} is not valid JSON`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const result = profileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues;
    throw badRequest(
      `Resume profile at ${path} is invalid — ${describeIssues(issues)}`,
      {
        path,
        fields: issues.map((issue) => issue.path.join(".")),
        issues: issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }

  cache.set(path, result.data);
  return result.data;
}

/** Which of the two sources answered. Reported straight through the API. */
export type ProfileSource = "stored" | "seed";

export type ResolvedProfile = { profile: Profile; source: ProfileSource };

/**
 * The profile the resume pipeline should use: the saved row if there is one,
 * otherwise the seed.
 *
 * An incomplete saved row is a hard failure rather than a silent fall back to
 * the seed, because the seed is a different human. Rendering someone else's
 * name onto this candidate's resume is strictly worse than refusing with the
 * list of fields to fill in, which is exactly what `missing` carries.
 */
export function resolveProfile(
  store: { get(): ProfileDraft | null },
  path: string = DEFAULT_PROFILE_PATH,
): ResolvedProfile {
  const stored = store.get();
  if (stored === null) return { profile: loadProfile(path), source: "seed" };

  const completeness = profileCompleteness(stored);
  if (!completeness.ready) {
    throw badRequest(
      `Your profile is missing ${completeness.missing.join(", ")}. ` +
        "Fill those in before generating a resume.",
      { missing: completeness.missing, score: completeness.score },
    );
  }

  return { profile: draftToProfile(stored), source: "stored" };
}

export function clearProfileCache(): void {
  cache.clear();
}
