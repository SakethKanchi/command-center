/**
 * Metric computation and CI gates for the golden-set eval.
 *
 * Pure functions only: no I/O, no clock, no network, no `process.env`. The
 * runner (`evals/run.ts`) owns every side effect, so the metric math can be
 * asserted directly in `evals/scoring.test.ts`.
 *
 * The metric is agreement-with-reference, not absolute correctness: each case
 * carries a frozen reference verdict, and we measure how closely the subject
 * under evaluation (this repo's LLM scoring and tailoring) reproduces it.
 */

/** Categorical suitability bands. Lower bound is inclusive. */
export const SCORE_BANDS = [
  { label: "strong", min: 65 },
  { label: "moderate", min: 40 },
  { label: "weak", min: 20 },
  { label: "reject", min: 0 },
] as const;

export type ScoreBand = (typeof SCORE_BANDS)[number]["label"];

/**
 * Default +/- band on the 0-100 suitability scale that still counts as
 * agreement with the reference score.
 *
 * Ported from `career-ops/eval-golden.mjs`, where `SCORE_TOLERANCE = 0.5` on a
 * 1-5 rubric — 12.5% of that scale's range. This repo's scorer emits 0-100
 * (see `JOB_SCORING_SCHEMA` in `src/server/llm/score-job.ts`), so
 * the equivalent band is +/-10 points. Overridable per case via
 * `expected.tolerance`.
 */
export const DEFAULT_SCORE_TOLERANCE = 10;

/** Tolerance for tailoring cases, whose score is a keyword-coverage percentage. */
export const DEFAULT_COVERAGE_TOLERANCE = 25;

/**
 * Fraction of cases whose categorical label must match the reference label.
 *
 * Ported from `career-ops/eval-golden.mjs` (`MIN_ARCHETYPE_AGREEMENT = 0.8`).
 * Upstream gated on archetype exact-match because it is the clean 0/1 signal;
 * the band label plays that role here.
 */
export const MIN_LABEL_AGREEMENT = 0.8;

/**
 * Fraction of cases whose numeric score must land inside the reference band.
 *
 * Upstream reported mean |delta score| as a secondary, non-gating signal. We
 * promote the tolerance hit-rate to a second gate — a model can hide individual
 * blowouts behind a low mean, and the hit-rate cannot be gamed that way. Same
 * 0.8 threshold as the label gate so one knob explains both.
 */
export const MIN_WITHIN_TOLERANCE = 0.8;

/** Comparisons are inclusive; keep float division from tripping an exact gate. */
const GATE_EPSILON = 1e-9;

export interface EvalGates {
  minLabelAgreement: number;
  minWithinTolerance: number;
}

export const DEFAULT_GATES: EvalGates = {
  minLabelAgreement: MIN_LABEL_AGREEMENT,
  minWithinTolerance: MIN_WITHIN_TOLERANCE,
};

export interface GoldenCaseExpectation {
  /** Reference categorical verdict — the gating signal. */
  label: string;
  /** Reference numeric verdict on the case's own scale. */
  score: number;
  /** Optional per-case override of the +/- agreement band. */
  tolerance?: number;
  /** Tailoring only: terms from the posting that must survive into the output. */
  requiredKeywords?: string[];
  /** Tailoring only: claims the candidate cannot support and must not appear. */
  forbiddenFabrications?: string[];
  /** How the reference verdict was set. */
  provenance?: string;
}

export interface GoldenCase {
  id: string;
  kind: "scoring" | "tailoring";
  expected: GoldenCaseExpectation;
  notes?: string;
}

/** One observation of the subject under evaluation, replayed or live. */
export interface CaseResult {
  caseId: string;
  /** Categorical verdict derived from the model output. */
  label?: string;
  /** Numeric verdict derived from the model output. */
  score?: number;
  /** Wall-clock time of the call; absent in replay. */
  latencyMs?: number;
  /** Set when the output was missing or unusable — the case then counts as a miss. */
  error?: string;
  /** Human-readable detail for the report (missing keywords, fabrications, ...). */
  detail?: string;
}

export interface CaseRow {
  caseId: string;
  kind: GoldenCase["kind"];
  expectedLabel: string;
  expectedScore: number;
  tolerance: number;
  observedLabel: string | null;
  observedScore: number | null;
  delta: number | null;
  labelMatch: boolean;
  withinTolerance: boolean;
  passed: boolean;
  latencyMs: number | null;
  error: string | null;
  detail: string | null;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
}

export interface AgreementMetrics {
  /** Cases in the golden set under consideration. */
  total: number;
  /** Cases that produced a usable observation. */
  evaluated: number;
  /** Cases whose observation was missing or unusable. */
  errored: number;
  labelMatches: number;
  /** labelMatches / total — errors count against the model, never excluded. */
  labelAgreement: number;
  withinTolerance: number;
  withinToleranceFraction: number;
  /** Mean |observed - reference| over cases with a numeric observation. */
  meanAbsoluteScoreError: number | null;
  scoredCount: number;
  latency: LatencySummary | null;
}

export interface AgreementReport {
  rows: CaseRow[];
  metrics: AgreementMetrics;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
}

/** Map a 0-100 suitability score onto its categorical band. */
export function bandForScore(score: number): ScoreBand {
  if (!Number.isFinite(score)) {
    throw new RangeError(`bandForScore requires a finite score, got ${score}`);
  }
  const clamped = Math.min(100, Math.max(0, score));
  for (const band of SCORE_BANDS) {
    if (clamped >= band.min) return band.label;
  }
  // SCORE_BANDS ends at min 0 and the score is clamped, so this is unreachable.
  return "reject";
}

/**
 * Whole-word, case-insensitive containment. Used so a required keyword like
 * "Java" is not satisfied by "JavaScript".
 */
export function containsTerm(haystack: string, term: string): boolean {
  const trimmed = term.trim();
  if (trimmed === "") return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = /^\w/.test(trimmed) ? "\\b" : "";
  const trailing = /\w$/.test(trimmed) ? "\\b" : "";
  return new RegExp(`${leading}${escaped}${trailing}`, "i").test(haystack);
}

/** Raw model output for a scoring case, in the shape `SCORING_SCHEMA` returns. */
export interface ScoringOutput {
  score: number;
  reason: string;
}

/**
 * Raw model output for a tailoring case, in the shape
 * `RESUME_TAILORING_SCHEMA` returns (`src/server/llm/tailor-resume.ts`).
 */
export interface TailoringOutput {
  headline: string;
  summary: string;
  skills: string[];
}

/** Derive the categorical + numeric observation for a scoring case. */
export function deriveScoringObservation(output: ScoringOutput): {
  label: ScoreBand;
  score: number;
  detail: string;
} {
  const score = output.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new TypeError(`scoring output carried no numeric score: ${score}`);
  }
  return {
    label: bandForScore(score),
    score,
    detail: (output.reason ?? "").trim().slice(0, 80),
  };
}

/**
 * Derive the observation for a tailoring case.
 *
 * Score is required-keyword coverage as a percentage, so it shares the 0-100
 * scale and the tolerance machinery with scoring cases. Label is the guardrail
 * verdict: any forbidden claim is `fabricated` regardless of coverage, because
 * an invented credential is worse than a thin summary.
 */
export function deriveTailoringObservation(
  output: TailoringOutput,
  expected: GoldenCaseExpectation,
): {
  label: "faithful" | "thin" | "fabricated";
  score: number;
  detail: string;
} {
  const text = [output.headline, output.summary, ...(output.skills ?? [])]
    .filter((part) => typeof part === "string")
    .join("\n");
  const required = expected.requiredKeywords ?? [];
  const forbidden = expected.forbiddenFabrications ?? [];

  const missing = required.filter((term) => !containsTerm(text, term));
  const fabricated = forbidden.filter((term) => containsTerm(text, term));
  const coverage =
    required.length === 0
      ? 100
      : Math.round(
          ((required.length - missing.length) / required.length) * 100,
        );

  const label =
    fabricated.length > 0 ? "fabricated" : coverage >= 75 ? "faithful" : "thin";
  const detail = [
    fabricated.length > 0 ? `fabricated: ${fabricated.join(", ")}` : "",
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return { label, score: coverage, detail };
}

/**
 * Nearest-rank percentile (no interpolation), so every reported latency is a
 * value that was actually observed. `p` is 0-100. Returns 0 for an empty set.
 */
export function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export function summarizeLatency(values: number[]): LatencySummary | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return {
    count: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
  };
}

/**
 * Compare observations against the reference verdicts.
 *
 * A case with no result, or a result carrying an error, stays in the
 * denominator and counts as a miss on both axes — a harness that silently drops
 * unusable outputs reports a vacuous pass.
 */
export function scoreAgreement(
  cases: GoldenCase[],
  results: CaseResult[],
): AgreementReport {
  const byId = new Map<string, CaseResult>();
  for (const result of results) byId.set(result.caseId, result);

  const rows: CaseRow[] = [];
  const deltas: number[] = [];
  const latencies: number[] = [];

  for (const testCase of cases) {
    const expected = testCase.expected;
    const tolerance =
      expected.tolerance ??
      (testCase.kind === "tailoring"
        ? DEFAULT_COVERAGE_TOLERANCE
        : DEFAULT_SCORE_TOLERANCE);
    const result = byId.get(testCase.id);

    const base = {
      caseId: testCase.id,
      kind: testCase.kind,
      expectedLabel: expected.label,
      expectedScore: expected.score,
      tolerance,
    };

    if (!result) {
      rows.push({
        ...base,
        observedLabel: null,
        observedScore: null,
        delta: null,
        labelMatch: false,
        withinTolerance: false,
        passed: false,
        latencyMs: null,
        error: "no result for case",
        detail: null,
      });
      continue;
    }

    if (
      typeof result.latencyMs === "number" &&
      Number.isFinite(result.latencyMs)
    ) {
      latencies.push(result.latencyMs);
    }

    if (result.error || result.label === undefined) {
      rows.push({
        ...base,
        observedLabel: result.label ?? null,
        observedScore:
          typeof result.score === "number" && Number.isFinite(result.score)
            ? result.score
            : null,
        delta: null,
        labelMatch: false,
        withinTolerance: false,
        passed: false,
        latencyMs: result.latencyMs ?? null,
        error: result.error ?? "observation carried no label",
        detail: result.detail ?? null,
      });
      continue;
    }

    const observedScore =
      typeof result.score === "number" && Number.isFinite(result.score)
        ? result.score
        : null;
    const delta =
      observedScore === null ? null : Math.abs(observedScore - expected.score);
    if (delta !== null) deltas.push(delta);

    const labelMatch = result.label === expected.label;
    const withinTolerance = delta !== null && delta <= tolerance + GATE_EPSILON;

    rows.push({
      ...base,
      observedLabel: result.label,
      observedScore,
      delta,
      labelMatch,
      withinTolerance,
      passed: labelMatch && withinTolerance,
      latencyMs: result.latencyMs ?? null,
      error:
        observedScore === null ? "observation carried no numeric score" : null,
      detail: result.detail ?? null,
    });
  }

  const total = cases.length;
  const errored = rows.filter((row) => row.error !== null).length;
  const labelMatches = rows.filter((row) => row.labelMatch).length;
  const withinTolerance = rows.filter((row) => row.withinTolerance).length;

  return {
    rows,
    metrics: {
      total,
      evaluated: total - errored,
      errored,
      labelMatches,
      labelAgreement: total === 0 ? 0 : labelMatches / total,
      withinTolerance,
      withinToleranceFraction: total === 0 ? 0 : withinTolerance / total,
      meanAbsoluteScoreError:
        deltas.length === 0
          ? null
          : deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
      scoredCount: deltas.length,
      latency: summarizeLatency(latencies),
    },
  };
}

function meetsGate(value: number, gate: number): boolean {
  return value >= gate - GATE_EPSILON;
}

function asPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Apply the CI gates. An empty or fully unusable run fails closed. */
export function evaluateGates(
  metrics: AgreementMetrics,
  gates: EvalGates = DEFAULT_GATES,
): GateResult {
  const failures: string[] = [];

  if (metrics.total === 0) {
    failures.push("no golden cases were loaded — failing closed");
  } else if (metrics.evaluated === 0) {
    failures.push(
      `no case produced a usable observation (${metrics.errored}/${metrics.total} errored) — failing closed`,
    );
  }

  if (!meetsGate(metrics.labelAgreement, gates.minLabelAgreement)) {
    failures.push(
      `label agreement ${asPercent(metrics.labelAgreement)} (${metrics.labelMatches}/${metrics.total}) below gate ${asPercent(gates.minLabelAgreement)}`,
    );
  }

  if (!meetsGate(metrics.withinToleranceFraction, gates.minWithinTolerance)) {
    failures.push(
      `score-within-tolerance ${asPercent(metrics.withinToleranceFraction)} (${metrics.withinTolerance}/${metrics.total}) below gate ${asPercent(gates.minWithinTolerance)}`,
    );
  }

  return { passed: failures.length === 0, failures };
}

function pad(value: string, width: number): string {
  return value.length > width
    ? `${value.slice(0, width - 1)}~`
    : value.padEnd(width);
}

function padStart(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value.padStart(width);
}

export interface ReportMeta {
  mode?: string;
  model?: string;
}

/**
 * Render the fixed-width per-case table, the aggregate metrics, and a final
 * PASS/FAIL line. One screen for a reviewer; stable columns for a diff.
 */
export function formatReport(
  report: AgreementReport,
  gateResult: GateResult,
  meta: ReportMeta = {},
  gates: EvalGates = DEFAULT_GATES,
): string {
  const { rows, metrics } = report;
  const lines: string[] = [];
  const mode = meta.mode ?? "replay";
  const model = meta.model ?? "recorded";

  lines.push("");
  lines.push(
    `golden-set eval — ${metrics.total} case(s), mode=${mode}, model=${model}`,
  );
  lines.push("");
  lines.push(
    `  ${pad("case", 44)}${pad("kind", 10)}${pad("expected", 16)}${pad("observed", 16)}${padStart("delta", 7)}  res`,
  );
  lines.push(
    `  ${"-".repeat(44)}${"-".repeat(10)}${"-".repeat(16)}${"-".repeat(16)}${"-".repeat(7)}  ---`,
  );

  for (const row of rows) {
    const expected = `${row.expectedLabel} ${row.expectedScore}`;
    const observed =
      row.observedLabel === null
        ? "-"
        : `${row.observedLabel} ${row.observedScore ?? "-"}`;
    const delta = row.delta === null ? "n/a" : row.delta.toFixed(1);
    const verdict = row.passed ? "ok " : "MISS";
    lines.push(
      `  ${pad(row.caseId, 44)}${pad(row.kind, 10)}${pad(expected, 16)}${pad(observed, 16)}${padStart(delta, 7)}  ${verdict}`,
    );
    if (row.passed) continue;
    const why = [
      row.error,
      row.labelMatch ? null : `label miss (reference ${row.expectedLabel})`,
      row.withinTolerance ? null : `score outside +/-${row.tolerance}`,
      row.detail === "" ? null : row.detail,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join("; ");
    lines.push(`  ${" ".repeat(44)}^ ${why}`);
  }

  const mae =
    metrics.meanAbsoluteScoreError === null
      ? "n/a"
      : metrics.meanAbsoluteScoreError.toFixed(2);

  lines.push("");
  lines.push(
    `  ${pad("label agreement", 26)}: ${asPercent(metrics.labelAgreement)} (${metrics.labelMatches}/${metrics.total})   gate >= ${asPercent(gates.minLabelAgreement)}`,
  );
  lines.push(
    `  ${pad("score within tolerance", 26)}: ${asPercent(metrics.withinToleranceFraction)} (${metrics.withinTolerance}/${metrics.total})   gate >= ${asPercent(gates.minWithinTolerance)}`,
  );
  lines.push(
    `  ${pad("mean |delta score|", 26)}: ${mae} over ${metrics.scoredCount}/${metrics.total} scored`,
  );
  lines.push(
    `  ${pad("unusable observations", 26)}: ${metrics.errored}/${metrics.total}`,
  );
  lines.push(
    `  ${pad("latency p50/p95", 26)}: ${
      metrics.latency === null
        ? "n/a (replay makes no calls)"
        : `${metrics.latency.p50}ms / ${metrics.latency.p95}ms over ${metrics.latency.count}`
    }`,
  );

  lines.push("");
  if (gateResult.passed) {
    lines.push("  PASS — every gate met");
  } else {
    lines.push("  FAIL — gate(s) not met");
    for (const failure of gateResult.failures) lines.push(`    - ${failure}`);
  }
  lines.push("");

  return lines.join("\n");
}
