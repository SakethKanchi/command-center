/**
 * Suggested roles: what this candidate should be searching for, from the
 * profile alone.
 *
 * The scorer (`./score-job.ts`) judges one posting the user already found.
 * This is the other direction — it runs before there is a posting at all, so
 * it has no job text to anchor on and the same anti-inflation rules have to be
 * carried by the prompt instead. The hard disqualifiers there are the
 * suggestion rules here, inverted: never suggest a title the scorer would
 * reject the candidate for, because a suggestion that scores 8/100 is worse
 * than no suggestion.
 */

import type { Profile, RoleSuggestion } from "@domain";
import { upstreamError } from "@server/infra/errors";
import { z } from "zod";
import {
  type LlmClient,
  type LlmJsonSchema,
  renderProfileContext,
} from "./index";

/**
 * Enough to cover a candidate who straddles two disciplines, few enough that
 * the row stays scannable and every entry had to earn its place.
 */
export const MAX_ROLE_SUGGESTIONS = 6;

/** Long enough for a real title; past this it is a sentence, not a query. */
const MAX_TITLE_CHARS = 60;
const MAX_QUERY_CHARS = 60;

export const ROLE_SUGGESTION_SCHEMA: LlmJsonSchema = {
  name: "suggested_roles",
  schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            query: { type: "string" },
            reason: { type: "string" },
          },
          required: ["title", "query", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["suggestions"],
    additionalProperties: false,
  },
};

const suggestionResultSchema = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string().default(""),
        query: z.string().default(""),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

export type SuggestRolesInput = {
  profile: Profile;
  llm: LlmClient;
};

function buildSuggestionPrompt(profile: Profile): string {
  return [
    `Name up to ${MAX_ROLE_SUGGESTIONS} job titles this candidate should be`,
    "searching job boards for right now.",
    "",
    "RULES:",
    "- Suggest only titles the candidate would clear the stated requirements",
    "  for today. A title that would reject them on seniority, language or",
    "  discipline is worse than one fewer suggestion.",
    "- Never inflate seniority. Do not suggest Senior, Staff, Principal, Lead,",
    "  Head, Director, VP or Manager titles unless the profile already shows",
    "  work at that level.",
    "- Every suggestion must rest on the profile's own stack and experience.",
    "  Do not suggest a discipline the profile shows no work in, and never",
    "  credit a skill merely adjacent to one listed.",
    "- Cover the range the profile genuinely supports rather than restating one",
    "  title six ways. Two titles that would return the same postings are one",
    "  suggestion.",
    "- If the profile is too thin to support a title, leave it out. An empty",
    "  list is a valid answer.",
    "",
    "FIELDS:",
    `- title: the role as a job board words it, at most ${MAX_TITLE_CHARS}`,
    "  characters. No seniority the profile does not have, no company, no",
    "  location.",
    `- query: the search text that finds it, at most ${MAX_QUERY_CHARS}`,
    "  characters. Two to four words, no boolean operators, no punctuation —",
    "  it is matched against posting text as plain words.",
    "- reason: one sentence naming the specific profile evidence — a role, a",
    "  project, or a listed skill — that supports the title.",
    "",
    "CANDIDATE PROFILE:",
    renderProfileContext(profile),
  ].join("\n");
}

/**
 * Two suggestions that search for the same thing are one suggestion; the model
 * is told that and mostly obeys, so this is the backstop rather than the rule.
 */
function dedupe(suggestions: RoleSuggestion[]): RoleSuggestion[] {
  const seen = new Set<string>();
  const kept: RoleSuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = suggestion.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(suggestion);
  }
  return kept;
}

export async function suggestRoles(
  input: SuggestRolesInput,
): Promise<RoleSuggestion[]> {
  const raw = await input.llm.completeJson<unknown>({
    prompt: buildSuggestionPrompt(input.profile),
    schema: ROLE_SUGGESTION_SCHEMA,
  });

  const parsed = suggestionResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw upstreamError(
      `LLM returned unusable role suggestions: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
      { model: input.llm.model },
    );
  }

  const suggestions: RoleSuggestion[] = [];
  for (const candidate of parsed.data.suggestions) {
    const title = candidate.title.trim().slice(0, MAX_TITLE_CHARS).trim();
    if (title === "") continue;
    // A suggestion whose title survived but whose query did not is still
    // usable: the title is a search term too.
    const query =
      candidate.query.trim().slice(0, MAX_QUERY_CHARS).trim() || title;
    suggestions.push({ title, query, reason: candidate.reason.trim() });
  }

  return dedupe(suggestions).slice(0, MAX_ROLE_SUGGESTIONS);
}
