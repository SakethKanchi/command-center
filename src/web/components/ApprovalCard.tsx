import type { AgentStepDecision } from "@domain";
import type { EmailDraft } from "@web/lib/steps";
import { Ban, Loader2, Send } from "lucide-react";

/**
 * The one irreversible effect in the run, shown in full before it happens.
 * Nothing is summarised here: a reviewer approving an email is entitled to the
 * exact bytes that will leave the account.
 */
export function ApprovalCard({
  draft,
  deciding,
  onDecide,
}: {
  draft: EmailDraft;
  deciding: AgentStepDecision | null;
  onDecide: (decision: AgentStepDecision) => void;
}) {
  return (
    <div
      data-testid="approval-card"
      className="mt-3 rounded-sm border border-signal/45 bg-signal/5"
    >
      <p className="u-meta border-b border-signal/25 px-3 py-2 text-signal">
        Waiting on you — this mail has not been sent
      </p>

      <dl className="grid gap-1 px-3 py-2.5 text-[13px]">
        <div className="flex gap-2">
          <dt className="u-meta w-14 shrink-0 pt-0.5 text-ink-faint">To</dt>
          <dd className="u-mono min-w-0 break-all text-ink">{draft.to}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="u-meta w-14 shrink-0 pt-0.5 text-ink-faint">
            Subject
          </dt>
          <dd className="min-w-0 font-medium text-ink">{draft.subject}</dd>
        </div>
      </dl>

      <p
        data-testid="approval-body"
        className="whitespace-pre-wrap border-t border-signal/20 px-3 py-3 text-[13.5px] leading-relaxed text-ink-dim"
      >
        {draft.body}
      </p>

      <div className="flex flex-wrap gap-2 border-t border-signal/25 px-3 py-2.5">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onDecide("approve")}
          disabled={deciding !== null}
        >
          {deciding === "approve" ? (
            <Loader2 className="spin size-3.5" aria-hidden />
          ) : (
            <Send className="size-3.5" aria-hidden />
          )}
          Approve and send
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => onDecide("deny")}
          disabled={deciding !== null}
        >
          {deciding === "deny" ? (
            <Loader2 className="spin size-3.5" aria-hidden />
          ) : (
            <Ban className="size-3.5" aria-hidden />
          )}
          Deny
        </button>
      </div>
    </div>
  );
}
