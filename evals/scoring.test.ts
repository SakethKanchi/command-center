import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bandForScore,
  type CaseResult,
  containsTerm,
  DEFAULT_GATES,
  deriveTailoringObservation,
  evaluateGates,
  formatReport,
  type GoldenCase,
  percentile,
  scoreAgreement,
  summarizeLatency,
} from "./scoring";

/** A scoring case whose reference verdict is `label`/`score` with a +/-10 band. */
function scoringCase(id: string, label: string, score: number): GoldenCase {
  return { id, kind: "scoring", expected: { label, score, tolerance: 10 } };
}

describe("golden set on disk", () => {
  // `import.meta.dirname` is the directory of this file under both vitest and
  // tsx; jsdom's URL implementation is not accepted by node's fileURLToPath.
  const evalsDir = (import.meta as ImportMeta & { dirname: string }).dirname;
  const casesDir = `${evalsDir}/cases`;
  const fixturesDir = `${evalsDir}/fixtures`;
  const caseIds = readdirSync(casesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""));

  it("carries enough cases for the agreement fractions to mean something", () => {
    // Below ~12 cases a single disagreement moves label agreement by >8 points,
    // which puts the 0.8 gate inside the noise.
    expect(caseIds.length).toBeGreaterThanOrEqual(12);
  });

  it("has a replay fixture for every case, so replay never silently skips one", () => {
    const missing = caseIds.filter(
      (id) => !existsSync(`${fixturesDir}/${id}.json`),
    );
    expect(missing).toEqual([]);
  });

  it("has no orphan fixture without a case", () => {
    const orphans = readdirSync(fixturesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .filter((id) => !caseIds.includes(id));
    expect(orphans).toEqual([]);
  });
});

describe("bandForScore", () => {
  it("puts each boundary in the higher band", () => {
    expect(bandForScore(65)).toBe("strong");
    expect(bandForScore(64)).toBe("moderate");
    expect(bandForScore(40)).toBe("moderate");
    expect(bandForScore(39)).toBe("weak");
    expect(bandForScore(20)).toBe("weak");
    expect(bandForScore(19)).toBe("reject");
    expect(bandForScore(0)).toBe("reject");
  });

  it("clamps scores a provider returns outside 0-100", () => {
    expect(bandForScore(140)).toBe("strong");
    expect(bandForScore(-12)).toBe("reject");
  });

  it("refuses a non-numeric score rather than inventing a band", () => {
    expect(() => bandForScore(Number.NaN)).toThrow(RangeError);
  });
});

describe("containsTerm", () => {
  it("matches whole words only, so Java is not satisfied by JavaScript", () => {
    expect(containsTerm("I ship JavaScript and TypeScript", "Java")).toBe(
      false,
    );
    expect(containsTerm("Java, Python, SQL", "Java")).toBe(true);
  });

  it("is case-insensitive and tolerates punctuation in the term", () => {
    expect(containsTerm("built on node.js in production", "Node.js")).toBe(
      true,
    );
    expect(containsTerm("shipped C#/.NET services", "C#")).toBe(true);
    expect(containsTerm("no dotnet here", "C#")).toBe(false);
  });
});

describe("percentile", () => {
  it("is nearest-rank for an odd sample count", () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([30, 10, 20], 0)).toBe(10);
    expect(percentile([30, 10, 20], 100)).toBe(30);
  });

  it("takes the lower median for an even sample count, never an average", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it("reports a value that was actually observed at p95", () => {
    const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
    // ceil(0.95 * 20) = 19th of 20 sorted samples.
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile(values, 50)).toBe(1000);
  });

  it("returns 0 for an empty sample and ignores non-finite values", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([Number.NaN, 5, Number.POSITIVE_INFINITY], 50)).toBe(5);
  });
});

describe("summarizeLatency", () => {
  it("returns null when nothing was timed, as on the replay path", () => {
    expect(summarizeLatency([])).toBeNull();
  });

  it("summarizes p50/p95 over the timed calls", () => {
    expect(summarizeLatency([500, 100, 900, 300])).toEqual({
      count: 4,
      p50: 300,
      p95: 900,
    });
  });
});

describe("deriveTailoringObservation", () => {
  const expected = {
    label: "faithful",
    score: 100,
    requiredKeywords: ["Python", "React", "RAG", "SQL"],
    forbiddenFabrications: ["PhD", "security clearance"],
  };

  it("scores full keyword coverage as faithful", () => {
    const observation = deriveTailoringObservation(
      {
        headline: "Full Stack AI Engineer",
        summary: "Python and React work, production RAG over SQL warehouses.",
        skills: [],
      },
      expected,
    );
    expect(observation).toEqual({ label: "faithful", score: 100, detail: "" });
  });

  it("counts coverage from headline, summary and skills together", () => {
    const observation = deriveTailoringObservation(
      {
        headline: "Engineer",
        summary: "Python services.",
        skills: ["React", "SQL"],
      },
      expected,
    );
    expect(observation.score).toBe(75);
    expect(observation.label).toBe("faithful");
    expect(observation.detail).toBe("missing: RAG");
  });

  it("calls thin output thin once coverage drops below the floor", () => {
    const observation = deriveTailoringObservation(
      { headline: "Engineer", summary: "Python services.", skills: [] },
      expected,
    );
    expect(observation.score).toBe(25);
    expect(observation.label).toBe("thin");
  });

  it("labels a fabricated credential regardless of perfect coverage", () => {
    const observation = deriveTailoringObservation(
      {
        headline: "Full Stack AI Engineer, PhD",
        summary: "Python, React, RAG and SQL.",
        skills: [],
      },
      expected,
    );
    expect(observation.score).toBe(100);
    expect(observation.label).toBe("fabricated");
    expect(observation.detail).toBe("fabricated: PhD");
  });
});

describe("scoreAgreement", () => {
  it("reports 1.0 agreement for a set that reproduces every reference verdict", () => {
    const cases = [
      scoringCase("a", "strong", 80),
      scoringCase("b", "moderate", 50),
      scoringCase("c", "reject", 10),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "a", label: "strong", score: 80 },
      { caseId: "b", label: "moderate", score: 50 },
      { caseId: "c", label: "reject", score: 10 },
    ]);

    expect(report.metrics.labelAgreement).toBe(1);
    expect(report.metrics.withinToleranceFraction).toBe(1);
    expect(report.metrics.meanAbsoluteScoreError).toBe(0);
    expect(report.metrics.errored).toBe(0);
    expect(report.rows.every((row) => row.passed)).toBe(true);
    expect(evaluateGates(report.metrics).passed).toBe(true);
  });

  it("computes mean absolute error and the within-tolerance count", () => {
    const cases = [
      scoringCase("a", "strong", 80),
      scoringCase("b", "moderate", 50),
      scoringCase("c", "weak", 30),
      scoringCase("d", "reject", 10),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "a", label: "strong", score: 80 }, // delta 0
      { caseId: "b", label: "moderate", score: 55 }, // delta 5
      { caseId: "c", label: "weak", score: 20 }, // delta 10, exactly at the band
      { caseId: "d", label: "moderate", score: 45 }, // delta 35, label and band miss
    ]);

    expect(report.metrics.meanAbsoluteScoreError).toBe(12.5);
    expect(report.metrics.scoredCount).toBe(4);
    expect(report.metrics.withinTolerance).toBe(3);
    expect(report.metrics.withinToleranceFraction).toBe(0.75);
    expect(report.metrics.labelMatches).toBe(3);
    expect(report.rows.map((row) => row.delta)).toEqual([0, 5, 10, 35]);
    expect(report.rows[2]?.withinTolerance).toBe(true);
    expect(report.rows[3]?.passed).toBe(false);
  });

  it("honours a per-case tolerance override", () => {
    const cases: GoldenCase[] = [
      {
        id: "tight",
        kind: "scoring",
        expected: { label: "weak", score: 30, tolerance: 2 },
      },
      {
        id: "loose",
        kind: "scoring",
        expected: { label: "weak", score: 30, tolerance: 20 },
      },
    ];
    const report = scoreAgreement(cases, [
      { caseId: "tight", label: "weak", score: 36 },
      { caseId: "loose", label: "weak", score: 36 },
    ]);

    expect(report.rows[0]?.withinTolerance).toBe(false);
    expect(report.rows[1]?.withinTolerance).toBe(true);
    expect(report.metrics.labelAgreement).toBe(1);
  });

  it("defaults tailoring cases to the coverage tolerance", () => {
    const cases: GoldenCase[] = [
      {
        id: "tailor",
        kind: "tailoring",
        expected: {
          label: "faithful",
          score: 100,
          requiredKeywords: ["Python"],
        },
      },
    ];
    const report = scoreAgreement(cases, [
      { caseId: "tailor", label: "faithful", score: 75 },
    ]);

    expect(report.rows[0]?.tolerance).toBe(25);
    expect(report.rows[0]?.passed).toBe(true);
  });

  it("keeps a missing or unusable observation in the denominator as a miss", () => {
    const cases = [
      scoringCase("present", "strong", 80),
      scoringCase("absent", "strong", 80),
      scoringCase("broken", "strong", 80),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "present", label: "strong", score: 80 },
      { caseId: "broken", error: "replay fixture missing" },
    ]);

    expect(report.metrics.total).toBe(3);
    expect(report.metrics.evaluated).toBe(1);
    expect(report.metrics.errored).toBe(2);
    expect(report.metrics.labelAgreement).toBeCloseTo(1 / 3, 10);
    expect(report.rows[1]?.error).toBe("no result for case");
    expect(report.rows[2]?.error).toBe("replay fixture missing");
  });

  it("treats a label-only observation as a scoring miss", () => {
    const report = scoreAgreement(
      [scoringCase("a", "strong", 80)],
      [{ caseId: "a", label: "strong" }],
    );

    expect(report.metrics.labelMatches).toBe(1);
    expect(report.metrics.withinTolerance).toBe(0);
    expect(report.metrics.meanAbsoluteScoreError).toBeNull();
    expect(report.rows[0]?.error).toBe("observation carried no numeric score");
    expect(evaluateGates(report.metrics).passed).toBe(false);
  });

  it("summarizes latency only from timed observations", () => {
    const cases = [
      scoringCase("a", "strong", 80),
      scoringCase("b", "strong", 80),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "a", label: "strong", score: 80, latencyMs: 1200 },
      { caseId: "b", label: "strong", score: 80 },
    ]);

    expect(report.metrics.latency).toEqual({ count: 1, p50: 1200, p95: 1200 });
  });
});

describe("evaluateGates", () => {
  /** `matches` of `total` cases reproduce the reference label; scores always match. */
  function agreementAt(matches: number, total: number) {
    const cases: GoldenCase[] = [];
    const observations: CaseResult[] = [];
    for (let index = 0; index < total; index += 1) {
      const hit = index < matches;
      cases.push(scoringCase(`case-${index}`, "strong", 80));
      observations.push({
        caseId: `case-${index}`,
        label: hit ? "strong" : "moderate",
        score: 80,
      });
    }
    return scoreAgreement(cases, observations).metrics;
  }

  it("passes at exactly the 0.8 label-agreement gate", () => {
    const metrics = agreementAt(8, 10);
    expect(metrics.labelAgreement).toBe(0.8);
    expect(evaluateGates(metrics)).toEqual({ passed: true, failures: [] });
  });

  it("fails at 0.79 and names the gate that failed", () => {
    const metrics = agreementAt(79, 100);
    expect(metrics.labelAgreement).toBe(0.79);

    const gateResult = evaluateGates(metrics);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failures).toHaveLength(1);
    expect(gateResult.failures[0]).toContain("label agreement");
    expect(gateResult.failures[0]).toContain("79/100");
    expect(gateResult.failures[0]).toContain("below gate 80%");
  });

  it("fails the tolerance gate independently of the label gate", () => {
    const cases = [
      scoringCase("a", "strong", 80),
      scoringCase("b", "strong", 80),
      scoringCase("c", "strong", 80),
      scoringCase("d", "strong", 80),
      scoringCase("e", "strong", 80),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "a", label: "strong", score: 80 },
      { caseId: "b", label: "strong", score: 80 },
      { caseId: "c", label: "strong", score: 80 },
      { caseId: "d", label: "strong", score: 66 },
      { caseId: "e", label: "strong", score: 99 },
    ]);

    expect(report.metrics.labelAgreement).toBe(1);
    expect(report.metrics.withinToleranceFraction).toBe(0.6);

    const gateResult = evaluateGates(report.metrics);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failures).toHaveLength(1);
    expect(gateResult.failures[0]).toContain("score-within-tolerance");
    expect(gateResult.failures[0]).toContain("3/5");
  });

  it("fails closed on an empty golden set instead of reporting a vacuous pass", () => {
    const report = scoreAgreement([], []);

    expect(report.metrics.total).toBe(0);
    expect(report.metrics.labelAgreement).toBe(0);

    const gateResult = evaluateGates(report.metrics);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failures[0]).toContain("no golden cases");
  });

  it("fails closed when every case failed to produce an observation", () => {
    const report = scoreAgreement(
      [scoringCase("a", "strong", 80), scoringCase("b", "weak", 30)],
      [],
    );

    const gateResult = evaluateGates(report.metrics);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failures[0]).toContain(
      "no case produced a usable observation",
    );
    expect(gateResult.failures[0]).toContain("2/2 errored");
  });

  it("respects overridden gate thresholds", () => {
    const metrics = agreementAt(9, 10);
    expect(
      evaluateGates(metrics, {
        minLabelAgreement: 0.95,
        minWithinTolerance: 0.8,
      }).passed,
    ).toBe(false);
    expect(evaluateGates(metrics, DEFAULT_GATES).passed).toBe(true);
  });
});

describe("formatReport", () => {
  it("renders aligned columns and ends on a PASS line", () => {
    const cases = [
      scoringCase("scoring-alpha", "strong", 80),
      scoringCase("scoring-beta", "weak", 30),
    ];
    const report = scoreAgreement(cases, [
      { caseId: "scoring-alpha", label: "strong", score: 78 },
      { caseId: "scoring-beta", label: "weak", score: 30 },
    ]);
    const text = formatReport(report, evaluateGates(report.metrics), {
      mode: "replay",
    });
    const lines = text.split("\n");
    const rowLines = lines.filter((line) => line.includes("scoring-"));

    expect(rowLines).toHaveLength(2);
    expect(new Set(rowLines.map((line) => line.indexOf("scoring")))).toEqual(
      new Set([2]),
    );
    expect(rowLines[0]).toContain("strong 80");
    expect(rowLines[0]).toContain("strong 78");
    expect(text).toContain("label agreement");
    expect(text.trim().endsWith("PASS — every gate met")).toBe(true);
  });

  it("explains every miss and ends on a FAIL line", () => {
    const cases = [
      scoringCase("scoring-alpha", "moderate", 60),
      scoringCase("scoring-beta", "weak", 30),
    ];
    const report = scoreAgreement(cases, [
      {
        caseId: "scoring-alpha",
        label: "strong",
        score: 75,
        detail: "seniority ignored",
      },
      { caseId: "scoring-beta", label: "weak", score: 30 },
    ]);
    const text = formatReport(report, evaluateGates(report.metrics), {
      mode: "replay",
    });

    expect(text).toContain("label miss (reference moderate)");
    expect(text).toContain("score outside +/-10");
    expect(text).toContain("seniority ignored");
    expect(text).toContain("FAIL — gate(s) not met");
    expect(text).toContain("label agreement 50%");
  });
});
