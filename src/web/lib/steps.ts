import type { AgentApp, AgentRunDetail, AgentStep } from "@domain";

/**
 * Turns a persisted step's opaque `input` / `output` into the one line a human
 * reads in the trace.
 *
 * Every read here is defensive on purpose. The payloads are `unknown` because
 * they are whatever the tool returned and were round-tripped through SQLite
 * JSON; a renamed field must degrade to a generic line, never blank the run
 * trace mid-demo.
 */

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export type VerifyReport = {
  score: number | null;
  passed: boolean | null;
  threshold: number | null;
  unsupportedClaims: number | null;
  styleWarnings: number | null;
};

/**
 * The `verify_resume` gate is the reliability claim of the whole run, so it is
 * pulled out of the generic summariser and rendered as its own line.
 */
export function readVerifyReport(step: AgentStep): VerifyReport | null {
  if (step.tool !== "verify_resume") return null;
  const output = record(step.output);
  if (!output) return null;
  const ats = record(output.ats);
  return {
    score: num(ats?.score),
    passed: typeof ats?.passed === "boolean" ? ats.passed : null,
    threshold: num(ats?.threshold),
    unsupportedClaims: Array.isArray(output.fabrications)
      ? output.fabrications.length
      : null,
    styleWarnings: Array.isArray(output.styleWarnings)
      ? output.styleWarnings.length
      : null,
  };
}

export type EmailDraft = { to: string; subject: string; body: string };

/**
 * A parked send step holds the drafted mail in `input`; `output` stays null
 * until somebody approves it. Reading `input` is therefore the only way to show
 * a reviewer what they are about to send.
 */
export function readEmailDraft(step: AgentStep): EmailDraft | null {
  const source = record(step.input) ?? record(step.output);
  if (!source) return null;
  const to = str(source.to);
  const subject = str(source.subject);
  const body = str(source.body);
  if (!to || !subject || !body) return null;
  return { to, subject, body };
}

export function summarizeStep(step: AgentStep): string {
  if (step.status === "failed") {
    return step.errorMessage ?? "The step failed without a message.";
  }
  if (step.status === "skipped") {
    return step.errorMessage ?? "Skipped: nothing to do for this job.";
  }
  if (step.status === "denied") {
    return "Denied by you. Nothing was sent.";
  }
  if (step.status === "pending") return "Queued.";
  if (step.status === "running") return "Working…";

  const output = record(step.output);
  const input = record(step.input);

  switch (step.tool) {
    case "discover_jobs": {
      const considered = num(output?.considered);
      const inserted = num(output?.inserted);
      const updated = num(output?.updated);
      const sources = Array.isArray(output?.sources)
        ? (output.sources as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      if (considered === null && inserted === null) return "Boards scanned.";
      const where = sources.length > 0 ? ` from ${sources.join(", ")}` : "";
      return `${considered ?? 0} postings scanned${where} — ${inserted ?? 0} new, ${updated ?? 0} refreshed`;
    }

    case "score_job": {
      const score = num(output?.score);
      const reason = str(output?.reason) ?? str(output?.scoreReason);
      if (score === null) return reason ?? "Scored.";
      return reason ? `Fit ${score}/100 — ${reason}` : `Fit ${score}/100`;
    }

    case "tailor_resume": {
      const headline = str(output?.headline) ?? str(output?.tailoredHeadline);
      return headline
        ? `Headline rewritten: "${headline}"`
        : "Resume tailored to the posting.";
    }

    case "render_resume_pdf": {
      const path = str(output?.pdfPath);
      // The template is what makes two runs of the same job look different, so
      // the trace names it rather than leaving the reader to diff two PDFs.
      const template = str(output?.template);
      const suffix = template ? ` (${template} template)` : "";
      return path
        ? `PDF written to ${path}${suffix}`
        : `PDF rendered${suffix}.`;
    }

    case "verify_resume": {
      const report = readVerifyReport(step);
      if (!report) return "Resume verified.";
      return report.passed === false
        ? "Gate failed — nothing was sent."
        : "Gate passed: formatting, facts and phrasing all clear.";
    }

    case "draft_outreach_email": {
      const draft = readEmailDraft(step);
      return draft
        ? `Drafted to ${draft.to} — "${draft.subject}"`
        : "Outreach drafted.";
    }

    case "send_outreach_email": {
      const to = str(output?.to) ?? str(input?.to);
      if (step.status === "awaiting_approval") {
        return to
          ? `Waiting on you before mailing ${to}.`
          : "Waiting on your approval before sending.";
      }
      return to ? `Sent to ${to}` : "Outreach sent.";
    }

    case "push_sheets":
    case "push_notion": {
      const created = num(output?.created) ?? 0;
      const updated = num(output?.updated) ?? 0;
      const unchanged = num(output?.unchanged) ?? 0;
      if (created + updated + unchanged === 0) return "No rows needed writing.";
      return `${created} row${created === 1 ? "" : "s"} created, ${updated} updated, ${unchanged} already current`;
    }

    case "record_application": {
      const stage = str(output?.stage);
      return stage
        ? `Application recorded at stage "${stage}".`
        : "Application recorded locally.";
    }

    case "schedule_follow_up": {
      const reason = str(output?.reason);
      const title = str(output?.title);
      return reason ?? title ?? "Follow-up scheduled.";
    }

    default:
      return "Done.";
  }
}

/** Destination the step wrote to, when it produced one worth opening. */
export function stepDestination(step: AgentStep): string | null {
  const output = record(step.output);
  return str(output?.destinationUrl) ?? str(output?.webUrl);
}

/**
 * Distinct systems the run touched, in the order it first touched them. This is
 * the multi-app claim rendered as data rather than asserted in a caption.
 */
export function systemsTouched(run: AgentRunDetail): AgentApp[] {
  const seen = new Set<AgentApp>();
  const ordered: AgentApp[] = [];
  for (const step of run.steps) {
    if (step.status === "pending" || seen.has(step.app)) continue;
    seen.add(step.app);
    ordered.push(step.app);
  }
  return ordered;
}
