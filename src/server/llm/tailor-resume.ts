/**
 * Resume tailoring: a headline, a summary and reordered skill groups for one
 * posting.
 *
 * Every rule in this prompt exists because the output is checked. The fact
 * gate (`src/server/verification/fact-gate.ts`) rejects any number the profile
 * does not evidence and any stretched employment span, and an application
 * whose document fails the gate never goes out. Telling the model that up
 * front is cheaper than discovering the fabrication downstream, and the
 * "reframe, never invent" framing is career-ops' (MIT, credited in NOTICE).
 */

import type { Profile, SkillGroup } from "@domain";
import { upstreamError } from "@server/infra/errors";
import { z } from "zod";
import {
  type JobContext,
  type LlmClient,
  type LlmJsonSchema,
  renderJobContext,
  renderProfileContext,
  UNTRUSTED_INPUT_RULE,
} from "./index";

/** Recruiters skim; past this the summary stops being read at all. */
export const MAX_SUMMARY_WORDS = 80;

export const RESUME_TAILORING_SCHEMA: LlmJsonSchema = {
  name: "tailored_resume_content",
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
          },
          required: ["name", "keywords"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "summary", "skills"],
    additionalProperties: false,
  },
};

const tailoringResultSchema = z.object({
  headline: z.string().default(""),
  summary: z.string().default(""),
  skills: z
    .array(
      z.object({
        name: z.string().default(""),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type TailorResumeInput = {
  job: JobContext;
  profile: Profile;
  llm: LlmClient;
};

export type TailorResumeResult = {
  headline: string;
  summary: string;
  skills: SkillGroup[];
};

function buildTailoringPrompt(job: JobContext, profile: Profile): string {
  return [
    "Rewrite this candidate's resume headline, summary and skill groups to",
    "target this specific job.",
    "",
    UNTRUSTED_INPUT_RULE,
    "",
    "ANTI-FABRICATION RULES. These are not style advice:",
    "- Never invent an employer, job title, employment date, degree,",
    "  certification, clearance, publication or metric. If it is not in the",
    "  CANDIDATE PROFILE block below, it does not exist.",
    "- Every number you write must already appear in the profile, attached to",
    "  the same thing it was attached to there. Do not round it up, do not",
    "  restate a percentage as a multiple, do not widen a date range.",
    "- Do not claim the candidate built, authored or maintained a tool,",
    "  library or framework that the profile only shows them using.",
    "- Do not add years of experience, seniority or scope the profile does",
    "  not show, even where the posting asks for them. A missing requirement",
    "  is left unaddressed, never papered over.",
    "- An automated fact gate checks this output against the profile before",
    "  the resume is rendered. Any claim the profile does not support is",
    "  rejected there and the application is blocked, so an invented detail",
    "  costs the candidate the role rather than winning it.",
    "",
    "WHAT TO DO INSTEAD: reorder, reframe and re-word what is already true.",
    "Lead with the profile's work that matches the posting. Mirror the",
    "posting's terminology when the profile backs the same thing under a",
    "different name, and prefer the candidate's own phrasing over generic",
    "resume filler.",
    "",
    "FIELDS:",
    "- headline: one line, at most about 12 words, naming the role the",
    "  candidate is presenting as. It must stay truthful to their level.",
    `- summary: under ${MAX_SUMMARY_WORDS} words, plain declarative sentences,`,
    "  no first-person pronouns and no adjective padding. Name the concrete",
    "  work that matches this posting.",
    "- skills: three to six groups, each a short group name and the keywords",
    "  the profile supports, ordered so the posting's requirements come",
    "  first. Drop a group entirely rather than padding it.",
    "",
    "CANDIDATE PROFILE:",
    renderProfileContext(profile),
    "",
    "JOB:",
    renderJobContext(job),
  ].join("\n");
}

export async function tailorResume(
  input: TailorResumeInput,
): Promise<TailorResumeResult> {
  const raw = await input.llm.completeJson<unknown>({
    prompt: buildTailoringPrompt(input.job, input.profile),
    schema: RESUME_TAILORING_SCHEMA,
  });

  const parsed = tailoringResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw upstreamError(
      `LLM returned unusable tailored resume content: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
      { model: input.llm.model },
    );
  }

  const skills: SkillGroup[] = [];
  for (const group of parsed.data.skills) {
    const name = group.name.trim();
    const keywords = group.keywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword !== "");
    // A group with no name has nowhere to render, and one with no keywords is
    // a heading over blank space; both are worse than the group being absent.
    if (name === "" || keywords.length === 0) continue;
    skills.push({ name, keywords });
  }

  return {
    headline: parsed.data.headline.trim(),
    summary: parsed.data.summary.trim(),
    skills,
  };
}
