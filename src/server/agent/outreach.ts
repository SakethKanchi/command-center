import type { Job, OutboundEmailRequest, Profile } from "@domain";
import { badRequest } from "@server/infra/errors";
import { htmlToText } from "@server/ingest/types";
import type { LlmClient, LlmJsonSchema } from "@server/llm";
import { UNTRUSTED_INPUT_RULE } from "@server/llm";

/** Longest job description we feed the model; beyond this adds cost, not signal. */
const JD_CHAR_BUDGET = 6_000;
/** Hard ceiling on the generated body. Recruiter notes that run long get skimmed. */
const BODY_WORD_LIMIT = 140;

const OUTREACH_SCHEMA: LlmJsonSchema = {
  name: "outreach_email",
  schema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description:
          "Email subject line. Under 80 characters, no emoji, names the role.",
      },
      body: {
        type: "string",
        description: `Plain-text email body, at most ${BODY_WORD_LIMIT} words. No markdown, no bullet characters, no signature block.`,
      },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  },
};

type OutreachDraft = { subject: string; body: string };

function buildPrompt(input: {
  job: Job;
  profile: Profile;
  tailoredHeadline: string | null;
}): string {
  const { job, profile, tailoredHeadline } = input;
  const description = htmlToText(job.descriptionText).slice(0, JD_CHAR_BUDGET);

  return [
    "Write a short outreach email applying for a role.",
    "",
    UNTRUSTED_INPUT_RULE,
    "",
    "## The role",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    job.location ? `Location: ${job.location}` : null,
    "",
    "Job description:",
    description || "(not available)",
    "",
    "## The candidate",
    `Name: ${profile.name}`,
    tailoredHeadline ? `Positioning: ${tailoredHeadline}` : null,
    profile.summary ? `Summary: ${profile.summary}` : null,
    "",
    "## Rules",
    `- At most ${BODY_WORD_LIMIT} words in the body.`,
    "- Plain text only: no markdown, no bullet characters, no links.",
    "- Do not invent employers, titles, dates, metrics, or credentials. Use only",
    "  facts present above. An unsupported claim fails an automated fact gate and",
    "  the email will be discarded.",
    "- Name one concrete, specific overlap between the candidate and this role.",
    "- Do not write a signature block, salutation placeholder, or subject in the body.",
    "- State that a tailored resume is attached.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Draft the outreach email for a job.
 *
 * Returns the request the Gmail connector would send, without sending it. The
 * split matters: drafting is cheap and reversible, sending is neither, so the
 * approval gate sits between them.
 */
export async function draftOutreachEmail(input: {
  job: Job;
  profile: Profile;
  tailoredHeadline: string | null;
  to: string;
  resumePath: string;
  llm: LlmClient;
}): Promise<OutboundEmailRequest> {
  const draft = await input.llm.completeJson<OutreachDraft>({
    prompt: buildPrompt({
      job: input.job,
      profile: input.profile,
      tailoredHeadline: input.tailoredHeadline,
    }),
    schema: OUTREACH_SCHEMA,
    maxAttempts: 2,
  });

  const subject = draft.subject?.trim();
  const body = draft.body?.trim();
  if (!subject || !body) {
    throw badRequest(
      "Model returned an outreach draft missing subject or body.",
    );
  }

  // A 50% overrun is a model that ignored the budget, not a near miss. Sending
  // it would bury the one specific overlap the whole message exists to make.
  const wordCount = body.split(/\s+/).length;
  if (wordCount > BODY_WORD_LIMIT * 1.5) {
    throw badRequest(
      `Outreach body ran to ${wordCount} words, over the ${BODY_WORD_LIMIT}-word budget.`,
    );
  }

  return {
    to: input.to,
    subject,
    body,
    attachments: [
      {
        filename: `${input.profile.name} - ${input.job.company}.pdf`
          .replace(/[/\\]/g, "-")
          .trim(),
        mimeType: "application/pdf",
        path: input.resumePath,
      },
    ],
  };
}
