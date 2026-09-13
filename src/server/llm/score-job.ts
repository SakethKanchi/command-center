/**
 * Fit scoring: one posting against the candidate profile.
 *
 * The rubric is adapted from career-ops' triage rules (MIT, credited in
 * NOTICE) — its hard-disqualifier list, soft-penalty stacking and
 * anti-fabrication clauses — rescaled from that project's 1-5 judgement onto
 * the 0-100 band scale this repo's golden-set eval grades against. The bands
 * are named in the prompt because a model given only "score 0-100" produces a
 * distribution that drifts between runs, and drift is what the eval catches.
 */

import type { JobBrief, Profile } from "@domain";
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

/**
 * Inclusive floors on the 0-100 scale. These are the same cut points the
 * golden-set harness grades against (`SCORE_BANDS` in `evals/scoring.ts`);
 * moving one here without moving it there silently shifts the pass bar.
 */
export const SCORE_BAND_FLOORS = {
  strong: 65,
  moderate: 40,
  weak: 20,
} as const;

export const JOB_SCORING_SCHEMA: LlmJsonSchema = {
  name: "job_fit_score",
  // Flat rather than nesting the brief: strict structured output is honoured
  // far more consistently by small models when there is no nested object.
  schema: {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string" },
      roleSummary: { type: "string" },
      mustHaves: { type: "array", items: { type: "string" } },
      niceToHaves: { type: "array", items: { type: "string" } },
      redFlags: { type: "array", items: { type: "string" } },
    },
    required: [
      "score",
      "reason",
      "roleSummary",
      "mustHaves",
      "niceToHaves",
      "redFlags",
    ],
    additionalProperties: false,
  },
};

const scoringResultSchema = z.object({
  // Coerced because a model that cannot emit a JSON number will emit "72";
  // anything that is not a number at all still fails here, which is the
  // outcome we want.
  score: z.coerce.number(),
  reason: z.string().default(""),
  roleSummary: z.string().default(""),
  mustHaves: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
});

export type ScoreJobInput = {
  job: JobContext;
  profile: Profile;
  llm: LlmClient;
};

export type ScoreJobResult = {
  score: number;
  reason: string;
  brief: JobBrief;
};

function buildScoringPrompt(job: JobContext, profile: Profile): string {
  return [
    "Score how well this candidate fits this job on a 0-100 scale.",
    "",
    UNTRUSTED_INPUT_RULE,
    "",
    "BANDS. The number you return must agree with the band you mean:",
    `- ${SCORE_BAND_FLOORS.strong}-100 STRONG: clears every stated hard`,
    "  requirement, the core stack is one the profile already works in, and",
    "  the seniority matches. Apply today.",
    `- ${SCORE_BAND_FLOORS.moderate}-${SCORE_BAND_FLOORS.strong - 1} MODERATE: real overlap, but one or two`,
    "  significant gaps such as required years, a required degree, or an",
    "  onsite location the candidate is not in. Worth applying, not a lock.",
    `- ${SCORE_BAND_FLOORS.weak}-${SCORE_BAND_FLOORS.moderate - 1} WEAK: adjacent work, most stated requirements`,
    "  unmet. Only worth a look if the candidate has time to spare.",
    `- 0-${SCORE_BAND_FLOORS.weak - 1} REJECT: a hard disqualifier applies, or the role is a`,
    "  different job entirely.",
    "",
    "HARD DISQUALIFIERS. Any one of these caps the score in the REJECT band,",
    "no matter how good the stack overlap is:",
    "- The posting requires citizenship, permanent residency, or a security",
    "  clearance, and the profile shows none.",
    "- The seniority is far above the profile: a Senior, Staff, Principal,",
    "  Lead, Head, Director, VP or Manager title, or a required years floor",
    "  more than double the experience the profile actually shows.",
    "- The primary language or platform is one the profile does not list as a",
    "  core skill (for example a Java, C#, Go, Rust, COBOL, Salesforce, SAP,",
    "  embedded or native-mobile role against a profile without it).",
    "- It is a different discipline: quota-carrying sales, mechanical or",
    "  civil design, research requiring publications, or a pure",
    "  infrastructure or data-platform role, against a profile with none.",
    "",
    "SOFT PENALTIES. Each costs roughly 5 to 10 points, and they stack:",
    "- Onsite or hybrid in a metro the profile is not based in.",
    "- A required degree or certification the profile does not hold.",
    "- A required years floor above the profile's experience but under double",
    "  it.",
    "- A single named cloud or vendor platform as a must-have that the profile",
    "  lists only in passing.",
    "- Stated compensation below what the profile's level implies.",
    "",
    "EVIDENCE RULES:",
    "- Judge only on what the posting states and what the profile contains. An",
    "  unstated requirement is not a requirement; unstated sponsorship,",
    "  relocation or clearance is not an allowance either. Do not guess at",
    "  what the employer probably meant.",
    "- Never credit the candidate with a skill merely adjacent to one they",
    "  list, and never treat using a tool as having built it.",
    "- Every must-have and red flag must trace to a specific line of the",
    "  posting. Do not invent a requirement the posting does not make.",
    "- If the posting is too thin to judge, say so in `reason` and score it no",
    "  higher than the MODERATE band.",
    "",
    "FIELDS:",
    "- score: the integer, consistent with the band you chose.",
    "- reason: one or two sentences naming the single biggest driver of the",
    "  number, and the hard disqualifier by name if one applied.",
    "- roleSummary: one sentence on what the job actually is.",
    "- mustHaves: requirements the posting states as required.",
    "- niceToHaves: requirements it states as preferred or bonus.",
    "- redFlags: concrete concerns for this candidate specifically.",
    "",
    "CANDIDATE PROFILE:",
    renderProfileContext(profile),
    "",
    "JOB:",
    renderJobContext(job),
  ].join("\n");
}

/** The three brief lists are cleaned identically; keep them in lockstep. */
function cleanList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

export async function scoreJob(input: ScoreJobInput): Promise<ScoreJobResult> {
  const raw = await input.llm.completeJson<unknown>({
    prompt: buildScoringPrompt(input.job, input.profile),
    schema: JOB_SCORING_SCHEMA,
  });

  const parsed = scoringResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw upstreamError(
      `LLM returned an unusable job score: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
      { model: input.llm.model },
    );
  }

  const { score, reason, roleSummary, mustHaves, niceToHaves, redFlags } =
    parsed.data;
  if (!Number.isFinite(score)) {
    throw upstreamError(`LLM returned a non-finite job score: ${score}`, {
      model: input.llm.model,
    });
  }

  return {
    score: Math.round(Math.min(100, Math.max(0, score))),
    reason: reason.trim(),
    brief: {
      roleSummary: roleSummary.trim(),
      mustHaves: cleanList(mustHaves),
      niceToHaves: cleanList(niceToHaves),
      redFlags: cleanList(redFlags),
    },
  };
}
