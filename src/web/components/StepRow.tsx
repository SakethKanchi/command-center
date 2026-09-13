import type { AgentStep, AgentStepDecision, AgentStepStatus } from "@domain";
import { APP_PRESENTATION } from "@web/lib/apps";
import { formatDuration } from "@web/lib/format";
import type { VerifyReport } from "@web/lib/steps";
import {
  readEmailDraft,
  readVerifyReport,
  stepDestination,
  summarizeStep,
} from "@web/lib/steps";
import { Ban, Check, Circle, Hourglass, Loader2, Minus, X } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { AppChip, DeepLink } from "./ui";

/**
 * `filled` drives the rail: a solid node means the step actually ran, a hollow
 * one means it never did. The spine can therefore be read for both "which
 * systems" and "how far did it get" without reading a word.
 */
const STATUS_PRESENTATION: Record<
  AgentStepStatus,
  { icon: typeof Check; tone: string; filled: boolean; ring?: string }
> = {
  pending: { icon: Circle, tone: "text-ink-faint", filled: false },
  running: { icon: Loader2, tone: "text-signal", filled: true },
  succeeded: { icon: Check, tone: "text-pass", filled: true },
  failed: { icon: X, tone: "text-alarm", filled: true, ring: "alarm" },
  skipped: { icon: Minus, tone: "text-ink-faint", filled: false },
  awaiting_approval: {
    icon: Hourglass,
    tone: "text-signal",
    filled: true,
    ring: "signal",
  },
  denied: { icon: Ban, tone: "text-alarm", filled: false, ring: "alarm" },
};

export function StepRow({
  step,
  isLast,
  longestMs,
  deciding,
  onDecide,
}: {
  step: AgentStep;
  isLast: boolean;
  longestMs: number;
  deciding: AgentStepDecision | null;
  onDecide: (stepId: string, decision: AgentStepDecision) => void;
}) {
  const presentation = STATUS_PRESENTATION[step.status];
  const StatusIcon = presentation.icon;
  const verify = readVerifyReport(step);
  const destination = stepDestination(step);
  const draft =
    step.status === "awaiting_approval" ? readEmailDraft(step) : null;
  const barPct =
    step.durationMs && longestMs > 0
      ? Math.max(3, (step.durationMs / longestMs) * 100)
      : 0;

  return (
    <li
      data-app={step.app}
      data-testid={`step-${step.seq}`}
      className="flex gap-3 px-4"
    >
      <div className="flex w-[18px] shrink-0 flex-col items-center pt-4">
        <span
          className="rail-node"
          data-filled={presentation.filled}
          data-ring={presentation.ring}
          aria-hidden
        />
        {isLast ? null : <span className="rail-line" aria-hidden />}
      </div>

      <div className="min-w-0 flex-1 pt-3.5 pb-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="u-meta text-ink-faint">
            {String(step.seq).padStart(2, "0")}
          </span>
          <span
            className="u-mono text-ink"
            title={
              step.idempotencyKey
                ? `Idempotency key ${step.idempotencyKey}`
                : undefined
            }
          >
            {step.tool}
          </span>
          <AppChip app={step.app} />
          {step.attempts > 1 ? (
            <span className="u-meta rounded-xs border border-signal/40 px-1 py-px text-signal">
              {step.attempts} attempts
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <span className="u-mono text-ink-faint">
              {formatDuration(step.durationMs)}
            </span>
            <StatusIcon
              className={`size-4 ${presentation.tone} ${step.status === "running" ? "spin" : ""}`}
              aria-label={step.status}
            />
          </span>
        </div>

        <p className="mt-1.5 text-[13.5px] text-ink-dim">
          {summarizeStep(step)}
        </p>

        {verify ? <VerifyLine report={verify} /> : null}

        {step.status === "failed" && step.errorCode ? (
          <p className="u-mono mt-2 rounded-sm border border-alarm/40 bg-alarm/10 px-2 py-1 text-[11.5px] text-alarm">
            {step.errorCode}
          </p>
        ) : null}

        {destination ? (
          <p className="mt-2">
            <DeepLink href={destination}>
              Open in {APP_PRESENTATION[step.app].label}
            </DeepLink>
          </p>
        ) : null}

        {barPct > 0 ? (
          <div className="mt-2.5 max-w-[220px]">
            <div className="dur-bar" style={{ width: `${barPct}%` }} />
          </div>
        ) : null}

        {draft ? (
          <ApprovalCard
            draft={draft}
            deciding={deciding}
            onDecide={(decision) => onDecide(step.id, decision)}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The verification gate, spelled out. A judge reading "ATS 87/100 pass" knows
 * the resume was checked by something other than the model that wrote it.
 */
function VerifyLine({ report }: { report: VerifyReport }) {
  const passed = report.passed !== false;
  return (
    <div
      data-testid="verify-line"
      className={`u-mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-2 py-1.5 text-[11.5px] ${passed ? "border-pass/40 bg-pass/8 text-pass" : "border-alarm/45 bg-alarm/10 text-alarm"}`}
    >
      <span className="font-semibold">
        ATS {report.score ?? "—"}/100 {passed ? "pass" : "FAIL"}
      </span>
      <span className="text-ink-dim">
        {report.unsupportedClaims ?? 0} unsupported{" "}
        {report.unsupportedClaims === 1 ? "claim" : "claims"}
      </span>
      <span className="text-ink-dim">
        {report.styleWarnings ?? 0} style{" "}
        {report.styleWarnings === 1 ? "warning" : "warnings"}
      </span>
    </div>
  );
}
