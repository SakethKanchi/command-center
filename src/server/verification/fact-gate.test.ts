import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORBIDDEN_PHRASES,
  type FactGateReport,
  normalizeClaim,
  verifyDocumentFacts,
} from "./fact-gate";

/** Claims the gate rejected, in document order. Forbidden phrases are opted out
 *  so the metric cases read exactly like upstream's `auditClaims(...).invented`. */
function invented(generated: string, source: string): string[] {
  return verifyDocumentFacts({
    generated,
    sources: [source],
    forbiddenPhrases: [],
  }).violations.map((violation) => violation.claim);
}

function gate(generated: string, sources: string[]): FactGateReport {
  return verifyDocumentFacts({ generated, sources, forbiddenPhrases: [] });
}

// ── Ported from verify-cv-facts.mjs --self-test ──────────────────────

describe("metric extraction against a source of truth", () => {
  const source = [
    "Reached 16,181 active users and 289,760 enrollments across 80 courses.",
    "Cut infrastructure cost 60%. Managed a $550K budget.",
    "Certified partners earned 2x more. Authored 80+ open-access technical guides.",
  ].join(" ");

  it("accepts a truthful restatement and catches an inflated count", () => {
    expect(invented("Reached 16,181 users", source)).toEqual([]);
    expect(invented("Reached 94,772 active users", source)).toEqual([
      "94772 users",
    ]);
  });

  it("catches an invented count of a different noun", () => {
    expect(invented("Drove 900,000 enrollments", source)).toEqual([
      "900000 enrollments",
    ]);
  });

  it("checks currency and multipliers", () => {
    expect(invented("Managed a $550K budget", source)).toEqual([]);
    expect(invented("Managed a $900K budget", source)).toEqual(["$900k"]);
    expect(invented("Partners earned 2x more", source)).toEqual([]);
  });

  it("treats a noun synonym as the same claim", () => {
    expect(invented("Authored 80 articles", source)).toEqual([]);
  });

  it("ignores an ordinary year", () => {
    expect(invented("Joined the team in 2013", source)).toEqual([]);
  });
});

describe("non-software headcount and physical scale", () => {
  const opsSource = [
    "Managed 20 staff across shift coverage: 8 scientists and 12 support personnel.",
    "Built out four facilities and ran a research program across 45 hectares.",
    "Held temperature setpoints across 3 production rooms.",
  ].join(" ");

  it("accepts a truthful headcount and catches an inflated one", () => {
    expect(invented("Managed 20 staff", opsSource)).toEqual([]);
    expect(invented("Managed 45 staff", opsSource)).toEqual(["45 staff"]);
    expect(invented("Led 30 scientists", opsSource)).toEqual(["30 scientists"]);
  });

  it("treats a headcount paraphrase as the same claim", () => {
    expect(invented("Managed 20 personnel", opsSource)).toEqual([]);
  });

  it("catches inflated site, area and room counts", () => {
    expect(invented("Built out 12 facilities", opsSource)).toEqual([
      "12 facilities",
    ]);
    expect(invented("Ran a program across 45 hectares", opsSource)).toEqual([]);
    expect(invented("Ran a program across 450 hectares", opsSource)).toEqual([
      "450 hectares",
    ]);
    expect(invented("Setpoints across 3 rooms", opsSource)).toEqual([]);
    expect(invented("Setpoints across 30 rooms", opsSource)).toEqual([
      "30 rooms",
    ]);
  });
});

describe("non-ASCII digits and thousands grouping", () => {
  const foldSource =
    "Reached 16,181 active users across 80 courses. Cut cost 60%.";

  it("catches a fabricated metric written in another script", () => {
    expect(invented("Reached ９４，７７２ users", foldSource)).toEqual([
      "94772 users",
    ]);
    expect(invented("Reached ٩٤٧٧٢ users", foldSource)).toEqual([
      "94772 users",
    ]);
    expect(invented("Reached ९४७७२ users", foldSource)).toEqual([
      "94772 users",
    ]);
    expect(invented("Cut cost ٩٩٪", foldSource)).toEqual(["99%"]);
  });

  it("does not turn a truthful localized document red", () => {
    expect(invented("Reached ١٦١٨١ users", foldSource)).toEqual([]);
    expect(invented("Reached １６，１８１ users", foldSource)).toEqual([]);
  });

  it("compares grouped and ungrouped spellings of the same number as equal", () => {
    expect(invented("Reached 16 181 users", foldSource)).toEqual([]);
    expect(invented("Reached 16181 users", foldSource)).toEqual([]);
    expect(invented("Reached 16.181 users", foldSource)).toEqual([]);
    expect(
      invented("Reached 16,181 users", "Reached 16.181 active users."),
    ).toEqual([]);
    expect(
      invented("Reached 1 234 567 users", "Reached 1234567 active users."),
    ).toEqual([]);
    expect(
      invented("Reached 12 345 678 users", "Reached 12345678 active users."),
    ).toEqual([]);
  });

  it("still catches a fabricated number whatever its grouping", () => {
    expect(invented("Reached 94 772 users", foldSource)).toEqual([
      "94772 users",
    ]);
    expect(invented("Reached 94.772 users", foldSource)).toEqual([
      "94772 users",
    ]);
  });

  it("does not read an ordinary decimal as grouping", () => {
    expect(
      invented("Cut build time to 2.5 hours", "Cut build time to 2.5 hours."),
    ).toEqual([]);
    // Pinned directly: with the same text on both sides, a regression that
    // folded 2.5 into 25 would keep the two equal and stay green.
    expect(normalizeClaim("2.5 hours")).toBe("2.5 hours");
  });

  it("does not glue a year to the number that follows it", () => {
    expect(invented("Joined in 2026 100 users", foldSource)).toEqual([
      "100 users",
    ]);
  });
});

describe("the modifier window", () => {
  const modifierSource =
    "Consolidated 25+ services down to ~5 live Cloud Run deployments.";

  it("does not let the modifier count decide whether a claim exists", () => {
    expect(
      invented(
        "25+ services consolidated to ~5 Cloud Run deployments",
        modifierSource,
      ),
    ).toEqual([]);
    expect(
      invented(
        "Consolidated to ~5 live production Cloud Run deployments",
        modifierSource,
      ),
    ).toEqual([]);
  });

  it("catches a changed number behind either phrasing", () => {
    expect(
      invented("Consolidated to ~9 live Cloud Run deployments", modifierSource),
    ).toEqual(["9 deployments"]);
    expect(
      invented("Consolidated to ~9 Cloud Run deployments", modifierSource),
    ).toEqual(["9 deployments"]);
  });

  it("does not let the chain jump over an intervening figure", () => {
    expect(
      invented("Ran 7 tests over 40 hours", "Ran 7 tests. Logged 40 hours."),
    ).toEqual([]);
    expect(
      invented(
        "Shipped 3 integrations",
        "Shipped 3 features across 12 integrations",
      ),
    ).toEqual(["3 integrations"]);
  });
});

describe("magnitude suffixes", () => {
  it("keeps the suffix attached to the number", () => {
    expect(
      invented("Grew the product to 50k users", "Reached 50 users."),
    ).toEqual(["50k users"]);
    expect(invented("Grew to 50k users", "Reached 50k users.")).toEqual([]);
    expect(invented("Drove 1.5M downloads", "Drove 50 downloads.")).toEqual([
      "1.5m downloads",
    ]);
    expect(invented("Reached 2B users", "Reached 1B users.")).toEqual([
      "2b users",
    ]);
  });

  it("leaves a spelled-out magnitude and a k-initial unit alone", () => {
    // Checked against an empty source so the extracted claim itself is pinned,
    // not merely the fact that both sides agree.
    expect(invented("Reached 50 million users", "")).toEqual(["50 users"]);
    expect(invented("Shipped 50kg servers", "")).toEqual(["50 servers"]);
  });
});

// ── Acceptance criteria ──────────────────────────────────────────────

describe("verifyDocumentFacts", () => {
  it("flags a number the sources do not contain", () => {
    const report = gate("Grew the platform to 12,000 monthly active users.", [
      "Grew the platform to 1200 monthly active users.",
    ]);
    expect(report.passed).toBe(false);
    expect(report.checkedClaims).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.kind).toBe("unsupported_metric");
    expect(report.violations[0]?.claim).toBe("12000 users");
    expect(report.violations[0]?.context).toContain(
      "12,000 monthly active users",
    );
  });

  it("does not flag the same number written in a different format", () => {
    const report = gate("Grew the platform to 1,200 monthly active users.", [
      "Grew the platform to 1200 monthly active users.",
    ]);
    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checkedClaims).toBe(1);
  });

  it("reads claims out of generated HTML", () => {
    expect(
      gate("<p>Grew to <strong>1,200</strong> users</p>", [
        "Grew to 1200 users.",
      ]).passed,
    ).toBe(true);
    expect(
      gate("<p>Grew to <strong>9,900</strong> users</p>", [
        "Grew to 1200 users.",
      ]).violations[0]?.claim,
    ).toBe("9900 users");
  });

  it("checks an employment span by its endpoints, not its punctuation", () => {
    expect(
      gate("Staff Engineer, Acme Corp, 2019-2024.", [
        "Acme Corp. Started in 2019, left in 2024.",
      ]).violations,
    ).toEqual([]);
    const stretched = gate("Staff Engineer, Acme Corp, 2016-2024.", [
      "Acme Corp. Started in 2019, left in 2024.",
    ]);
    expect(stretched.violations[0]?.kind).toBe("unsupported_number");
    expect(stretched.violations[0]?.claim).toBe("2016-2024");
  });

  it("passes an empty document without checking anything", () => {
    const report = verifyDocumentFacts({
      generated: "",
      sources: ["anything"],
    });
    expect(report.checkedClaims).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("reports every unsupported claim rather than stopping at the first", () => {
    const report = gate("Cut cost 60% for 94,772 users across 12 sites.", [
      "Cut cost 60% for 16,181 users.",
    ]);
    expect(report.violations.map((violation) => violation.claim)).toEqual([
      "94772 users",
      "12 sites",
    ]);
    expect(report.checkedClaims).toBe(3);
  });
});

describe("false-positive guards", () => {
  it("does not read a four-digit year as a count", () => {
    // "2024 platform migration across teams" is the exact shape of a count
    // claim and none of its meaning. The neighbouring real claim proves the
    // extractor is still live.
    expect(
      invented(
        "Led the 2024 platform migration across teams. Grew to 900 users.",
        "",
      ),
    ).toEqual(["900 users"]);
  });

  it("does not read digits inside a URL as claims", () => {
    expect(
      invented(
        "Write-up: https://example.com/case-studies/40%-faster-builds and mirror at docs.example.com/notes/3x-speedup. Cut cost 12%.",
        "",
      ),
    ).toEqual(["12%"]);
  });

  it("does not read a phone number as a count", () => {
    // A PDF extractor joins the contact line to the one after it, which used to
    // produce "0100 customers".
    expect(
      invented(
        "Reach me at +1 415 555 0100. Customers include Acme. Shipped 7 integrations.",
        "",
      ),
    ).toEqual(["7 integrations"]);
  });

  it("does not read a page-number footer as a count", () => {
    expect(
      invented(
        [
          "Jane Smith - Resume",
          "2",
          "Customers include Acme.",
          "Managed 40 staff.",
        ].join("\n"),
        "",
      ),
    ).toEqual(["40 staff"]);
  });

  it("accepts a document carrying all four at once", () => {
    const report = gate(
      [
        "Jane Smith",
        "+1 415 555 0100 | jane@example.com",
        "Graduated in 2019.",
        "Led the 2024 platform migration across teams.",
        "Portfolio: https://example.com/case-studies/40%-faster-builds",
        "2",
        "Customers include Acme and Globex.",
      ].join("\n"),
      ["Jane Smith is an engineer."],
    );
    expect(report.violations).toEqual([]);
    expect(report.checkedClaims).toBe(0);
    expect(report.passed).toBe(true);
  });
});

describe("forbidden phrases", () => {
  it("flags a banned phrase with its surrounding context", () => {
    const report = verifyDocumentFacts({
      generated:
        "Seasoned engineer with a proven track record of shipping payment systems.",
      sources: [],
    });
    expect(report.passed).toBe(false);
    const violation = report.violations.find(
      (candidate) => candidate.kind === "forbidden_phrase",
    );
    expect(violation?.claim).toBe("proven track record");
    expect(violation?.context).toContain(
      "engineer with a proven track record of shipping",
    );
  });

  it("ships the upstream cliché list by default", () => {
    expect(DEFAULT_FORBIDDEN_PHRASES).toContain("proven track record");
    expect(
      verifyDocumentFacts({
        generated: "Spearheaded the rollout.",
        sources: [],
      }).violations[0]?.claim,
    ).toBe("spearheaded");
  });

  it("lets the caller replace the list", () => {
    const report = verifyDocumentFacts({
      generated: "Spearheaded the rollout at a Fortune 500 client.",
      sources: [],
      forbiddenPhrases: ["Fortune 500"],
    });
    expect(report.violations.map((violation) => violation.claim)).toEqual([
      "Fortune 500",
    ]);
  });

  it("does not count a forbidden phrase as a checked claim", () => {
    const report = verifyDocumentFacts({
      generated: "A results-oriented engineer.",
      sources: [],
    });
    expect(report.checkedClaims).toBe(0);
    expect(report.violations).toHaveLength(1);
  });
});
