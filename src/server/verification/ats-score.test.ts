import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATS_WEIGHTS,
  type AtsDimension,
  type AtsScoreInput,
  type AtsScoreReport,
  DEFAULT_ATS_THRESHOLD,
  normalizeFontName,
  scoreAtsCompliance,
  scoreAtsComplianceForPdf,
} from "./ats-score";
import { extractPdfText, PdfTextExtractionError } from "./pdf-text";

// ── Fixtures ─────────────────────────────────────────────────────────

const PERFECT_RESUME_TEXT = [
  "Jane Smith",
  "jane@example.com | +1 415 555 0100 | San Francisco, CA",
  "",
  "Professional Summary",
  "Senior backend engineer with a decade of experience designing reliable, high-throughput distributed systems for payments and identity platforms. Comfortable owning a service from design review through on-call rotation.",
  "",
  "Work Experience",
  "Staff Engineer, Acme Corp (2020-present). Built and operated the core payments platform, reducing incident rates and improving deployment cadence across multiple engineering teams.",
  "Senior Engineer, Globex (2016-2020). Owned the identity service, migrated authentication to short-lived tokens, and cut median login latency substantially.",
  "",
  "Projects",
  "Open-source tracing toolkit adopted by several teams for latency debugging, with a plugin interface for custom span exporters.",
  "",
  "Education",
  "B.S. Computer Science, State University, 2018. Coursework in distributed systems, compilers, and databases.",
  "",
  "Skills",
  "Python, Go, Kubernetes, Docker, PostgreSQL, Terraform, distributed systems, CI/CD pipelines, observability.",
  "",
  "Certifications",
  "Certified Kubernetes Administrator (CNCF), 2022. AWS Solutions Architect Associate, 2021.",
].join("\n");

const PERFECT_INPUT: AtsScoreInput = {
  text: PERFECT_RESUME_TEXT,
  pageCount: 1,
  fontNames: ["ABCDEF+Arial-BoldMT", "Helvetica", "TimesNewRomanPSMT"],
  imageCount: 0,
  hiddenTextCharCount: 0,
};

/** Score, asserting the report invariants every case has to hold. */
function score(input: AtsScoreInput): AtsScoreReport {
  const report = scoreAtsCompliance(input);
  let total = 0;
  for (const item of report.breakdown) {
    expect(item.weight).toBe(ATS_WEIGHTS[item.dimension]);
    expect(item.earned).toBeGreaterThanOrEqual(0);
    expect(item.earned).toBeLessThanOrEqual(item.weight);
    total += item.earned;
  }
  expect(report.score).toBe(total);
  expect(report.passed).toBe(report.score >= report.threshold);
  return report;
}

function dimension(report: AtsScoreReport, name: AtsDimension) {
  const found = report.breakdown.find((item) => item.dimension === name);
  if (found === undefined) throw new Error(`no breakdown entry for ${name}`);
  return found;
}

function findings(report: AtsScoreReport, name: AtsDimension): string {
  return dimension(report, name).findings.join(" ").toLowerCase();
}

// ── Weights and the perfect case ─────────────────────────────────────

describe("the weighting", () => {
  it("sums to exactly 100", () => {
    const total = Object.values(ATS_WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBe(100);
  });

  it("reports one breakdown row per dimension", () => {
    const report = score(PERFECT_INPUT);
    expect(report.breakdown.map((item) => item.dimension)).toEqual([
      "text",
      "sections",
      "contact",
      "layout",
      "images",
      "fonts",
      "charset",
      "hidden",
    ]);
  });

  it("scores a clean single-column resume 100 with no findings", () => {
    const report = score(PERFECT_INPUT);
    expect(report.score).toBe(100);
    expect(report.passed).toBe(true);
    expect(report.threshold).toBe(DEFAULT_ATS_THRESHOLD);
    expect(report.breakdown.flatMap((item) => item.findings)).toEqual([]);
  });

  it("honours an overridden threshold", () => {
    expect(score({ ...PERFECT_INPUT, threshold: 100 }).passed).toBe(true);
    const strict = score({
      ...PERFECT_INPUT,
      fontNames: ["Comic Sans MS"],
      threshold: 100,
    });
    expect(strict.score).toBe(97);
    expect(strict.passed).toBe(false);
  });

  it("rejects a nonsense page count", () => {
    expect(() =>
      scoreAtsCompliance({ ...PERFECT_INPUT, pageCount: 0 }),
    ).toThrow(/pageCount/);
  });
});

// ── The scanned resume ───────────────────────────────────────────────

describe("a scanned resume with no text layer", () => {
  const scanned = score({
    text: "",
    pageCount: 2,
    fontNames: [],
    imageCount: 2,
    hiddenTextCharCount: 0,
  });

  it("scores near zero and fails the gate", () => {
    expect(scanned.score).toBeLessThanOrEqual(10);
    expect(scanned.passed).toBe(false);
  });

  it("names the missing text layer", () => {
    expect(findings(scanned, "text")).toContain("no usable text layer");
    expect(dimension(scanned, "text").earned).toBe(0);
  });

  it("refuses to award the checks the missing text layer took down with it", () => {
    for (const name of [
      "sections",
      "contact",
      "layout",
      "fonts",
      "charset",
    ] as const) {
      expect(dimension(scanned, name).earned).toBe(0);
      expect(findings(scanned, name)).toContain("no text layer");
    }
    // The content is in the artwork, which is the point of the images check.
    expect(dimension(scanned, "images").earned).toBe(0);
  });
});

// ── Each dimension, driven down on its own ───────────────────────────

describe("each dimension can be driven down independently", () => {
  const cases: Array<{
    name: AtsDimension;
    expected: number;
    input: AtsScoreInput;
    finding: string;
  }> = [
    {
      name: "text",
      expected: 8,
      input: { ...PERFECT_INPUT, pageCount: 4 },
      finding: "no extractable text",
    },
    {
      name: "sections",
      expected: 10,
      input: {
        ...PERFECT_INPUT,
        text: PERFECT_RESUME_TEXT.replace(
          /\nEducation\n[^\n]*\n/,
          "\n",
        ).replace(/\nSkills\n[^\n]*\n/, "\n"),
      },
      finding: '"education" heading',
    },
    {
      name: "contact",
      expected: 0,
      input: {
        ...PERFECT_INPUT,
        text: PERFECT_RESUME_TEXT.replace(
          "jane@example.com | +1 415 555 0100 | San Francisco, CA",
          "San Francisco, CA",
        ),
      },
      finding: "no parseable email address",
    },
    {
      name: "layout",
      expected: 8,
      input: {
        ...PERFECT_INPUT,
        text: `${PERFECT_RESUME_TEXT}\nSkill      Years      Level\nPython      8      Expert`,
      },
      finding: "three or more columns",
    },
    {
      name: "images",
      expected: 5,
      input: { ...PERFECT_INPUT, imageCount: 2 },
      finding: "2 image(s) embedded",
    },
    {
      name: "fonts",
      expected: 7,
      input: {
        ...PERFECT_INPUT,
        fontNames: ["ABCDEF+ComicSansMS", "Helvetica"],
      },
      finding: "comic sans ms",
    },
    {
      name: "charset",
      expected: 0,
      input: {
        ...PERFECT_INPUT,
        text: `${PERFECT_RESUME_TEXT}\nReference: Jos\uFFFD Garcia`,
      },
      finding: "did not survive text extraction",
    },
    {
      name: "hidden",
      expected: 0,
      input: { ...PERFECT_INPUT, hiddenTextCharCount: 37 },
      finding: "drawn invisibly",
    },
  ];

  for (const testCase of cases) {
    it(`drops only ${testCase.name}`, () => {
      const report = score(testCase.input);
      expect(dimension(report, testCase.name).earned).toBe(testCase.expected);
      expect(findings(report, testCase.name)).toContain(
        testCase.finding.toLowerCase(),
      );
      for (const item of report.breakdown) {
        if (item.dimension === testCase.name) continue;
        expect({ [item.dimension]: item.earned }).toEqual({
          [item.dimension]: item.weight,
        });
      }
    });
  }
});

// ── Ported from verify-ats.mjs --self-test ───────────────────────────

describe("section headings", () => {
  it("flags both missing required headings by name", () => {
    const report = score({
      ...PERFECT_INPUT,
      text: PERFECT_RESUME_TEXT.replace(/\nEducation\n[^\n]*\n/, "\n").replace(
        /\nSkills\n[^\n]*\n/,
        "\n",
      ),
    });
    const text = findings(report, "sections");
    expect(text).toContain("education");
    expect(text).toContain("skills");
  });

  it("does not read a bullet as a heading", () => {
    const report = score({
      ...PERFECT_INPUT,
      text: PERFECT_RESUME_TEXT.replace(
        /\nEducation\n/,
        "\n- Education and training\n",
      ),
    });
    expect(findings(report, "sections")).toContain('"education" heading');
  });

  it("accepts markdown headings", () => {
    const markdown = PERFECT_RESUME_TEXT.replace(
      /^(Professional Summary|Work Experience|Projects|Education|Skills|Certifications)$/gm,
      "## $1",
    );
    expect(
      dimension(score({ ...PERFECT_INPUT, text: markdown }), "sections").earned,
    ).toBe(20);
  });
});

describe("contact detection", () => {
  it("does not count a bare year range as a phone number", () => {
    const report = score({
      ...PERFECT_INPUT,
      text: PERFECT_RESUME_TEXT.replace("+1 415 555 0100", "2019 - 2024"),
    });
    expect(dimension(report, "contact").earned).toBe(10);
    expect(findings(report, "contact")).toContain("no phone number");
  });

  it("detects a real phone number", () => {
    expect(findings(score(PERFECT_INPUT), "contact")).toBe("");
  });
});

describe("layout", () => {
  it("flags a side-by-side two-column body", () => {
    const sidebar = [
      "Led the payments platform migration      Mentored four engineers on call",
      "Owned the identity service rewrite      Ran the weekly architecture forum",
      "Drove the observability rollout      Reviewed designs for three teams",
      "Built the release automation      Managed the on-call escalation policy",
    ].join("\n");
    const report = score({
      ...PERFECT_INPUT,
      text: `${PERFECT_RESUME_TEXT}\n${sidebar}`,
    });
    expect(dimension(report, "layout").earned).toBe(12);
    expect(findings(report, "layout")).toContain("side-by-side text columns");
  });

  it("does not flag a right-aligned date as a second column", () => {
    const dated = [
      "Staff Engineer, Acme Corp                 2020-2024",
      "Senior Engineer, Globex                   2016-2020",
      "Engineer, Initech                         2013-2016",
    ].join("\n");
    const report = score({
      ...PERFECT_INPUT,
      text: `${PERFECT_RESUME_TEXT}\n${dated}`,
    });
    expect(dimension(report, "layout").earned).toBe(ATS_WEIGHTS.layout);
  });

  it("flags text recovered as fragments", () => {
    // A sidebar recovered item by item: every glyph run lands on its own line,
    // which is what a broken reading order looks like after extraction.
    const report = score({
      ...PERFECT_INPUT,
      text: [
        "Jane Smith",
        "jane@example.com",
        "+1 415 555 0100",
        "Experience",
        "Education",
        "Skills",
        "Python",
        "Go",
        "Rust",
        "Kubernetes",
        "Docker",
        "Postgres",
        "Terraform",
        "Grafana",
        "Kafka",
        "Redis",
        "gRPC",
        "AWS",
        "GCP",
        "Bash",
        "Git",
        "Nix",
        "Vim",
        "Linux",
        "CI/CD",
        "Helm",
        "Istio",
        "Envoy",
        "Vault",
        "Consul",
        "Nomad",
        "Packer",
        "Ansible",
        "Puppet",
        "Chef",
        "Jenkins",
        "Argo",
        "Flux",
        "Tekton",
        "Spinnaker",
        "Prometheus",
        "OpenTelemetry",
        "Cloudflare",
        "Snowflake",
        "Databricks",
        "Airflow",
        "dbt",
        "Spark",
        "Flink",
        "Pulsar",
      ].join("\n"),
    });
    expect(findings(report, "layout")).toContain("fragments");
    expect(dimension(report, "layout").earned).toBe(ATS_WEIGHTS.layout - 4);
  });
});

describe("images", () => {
  it("zeroes the dimension when the text is thin enough to be baked in", () => {
    const report = score({
      ...PERFECT_INPUT,
      text: PERFECT_RESUME_TEXT.slice(0, 500),
      imageCount: 1,
    });
    expect(dimension(report, "images").earned).toBe(0);
    expect(findings(report, "images")).toContain("baked into the artwork");
  });
});

describe("fonts", () => {
  it("normalizes subset tags, packaging suffixes and style halves", () => {
    expect(normalizeFontName("ABCDEF+Arial-BoldMT")).toBe("arial");
    expect(normalizeFontName("TimesNewRomanPSMT")).toBe("times new roman");
    expect(normalizeFontName("LiberationSans-Regular")).toBe("liberation sans");
    expect(normalizeFontName("ComicSansMS")).toBe("comic sans ms");
  });

  it("never pays out below zero however many families are unsafe", () => {
    const report = score({
      ...PERFECT_INPUT,
      fontNames: ["Papyrus", "Jokerman", "Curlz MT", "Wingdings", "Chiller"],
    });
    expect(dimension(report, "fonts").earned).toBe(0);
  });

  it("awards the weight when no font information was captured", () => {
    const withoutFonts: AtsScoreInput = {
      text: PERFECT_RESUME_TEXT,
      pageCount: 1,
      imageCount: 0,
      hiddenTextCharCount: 0,
    };
    expect(dimension(score(withoutFonts), "fonts").earned).toBe(
      ATS_WEIGHTS.fonts,
    );
  });
});

// ── The PDF adapter ──────────────────────────────────────────────────

const PDF_LINES = [
  "Jane Smith",
  "jane@example.com | +1 415 555 0100 | San Francisco, CA",
  "Professional Summary",
  "Senior backend engineer with a decade of experience building reliable",
  "distributed systems for payments and identity platforms.",
  "Work Experience",
  "Staff Engineer, Acme Corp, 2020 to present. Built and operated the core",
  "payments platform and reduced incident rates across engineering teams.",
  "Senior Engineer, Globex, 2016 to 2020. Owned the identity service and",
  "migrated authentication to short-lived tokens.",
  "Projects",
  "Open-source tracing toolkit adopted by several teams for latency work.",
  "Education",
  "B.S. Computer Science, State University, 2018.",
  "Skills",
  "Python, Go, Kubernetes, Docker, PostgreSQL, Terraform, observability.",
  "Certifications",
  "Certified Kubernetes Administrator, CNCF, 2022.",
];

const HIDDEN_PDF_LINE = "python kubernetes aws rust golang terraform";

/** Assemble a PDF from numbered object bodies, with a correct xref table. */
function buildPdf(objects: string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function buildResumePdf(): Buffer {
  const image = "\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff"; // 2x2 RGB
  const body = [
    "q 120 0 0 60 430 700 cm /Im1 Do Q",
    "BT /F1 11 Tf 50 740 Td 15 TL",
    ...PDF_LINES.map((line) => `(${line}) Tj T*`),
    "ET",
    `BT /F2 8 Tf 3 Tr 50 60 Td (${HIDDEN_PDF_LINE}) Tj ET`,
  ].join("\n");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /ComicSansMS >>",
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ]);
}

/** A scan: one page that is nothing but a raster image, with no text layer. */
function buildScannedPdf(): Buffer {
  const image = "\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff"; // 2x2 RGB
  const body = "q 460 0 0 640 70 80 cm /Im1 Do Q";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ]);
}

describe("scoreAtsComplianceForPdf", () => {
  let directory = "";
  let resumePath = "";

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ats-score-"));
    resumePath = path.join(directory, "resume.pdf");
    await writeFile(resumePath, buildResumePdf());
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads the text, fonts, images and invisible text out of the file", async () => {
    const inputs = await extractPdfText(new Uint8Array(buildResumePdf()));
    expect(inputs.pageCount).toBe(1);
    expect(inputs.text).toContain("jane@example.com");
    expect(inputs.text.split("\n").length).toBeGreaterThan(10);
    expect(inputs.imageCount).toBe(1);
    expect(inputs.fontNames).toContain("ComicSansMS");
    expect(inputs.hiddenTextCharCount).toBe(
      HIDDEN_PDF_LINE.replace(/\s/g, "").length,
    );
  });

  it("scores the rendered file through the same pure function", async () => {
    const report = await scoreAtsComplianceForPdf(resumePath);
    expect(dimension(report, "text").earned).toBe(ATS_WEIGHTS.text);
    expect(dimension(report, "sections").earned).toBe(ATS_WEIGHTS.sections);
    expect(dimension(report, "contact").earned).toBe(ATS_WEIGHTS.contact);
    expect(dimension(report, "images").earned).toBe(5);
    expect(dimension(report, "fonts").earned).toBe(7);
    expect(findings(report, "fonts")).toContain("comic sans ms");
    expect(dimension(report, "hidden").earned).toBe(0);
    expect(findings(report, "hidden")).toContain("drawn invisibly");
    for (const item of report.breakdown) {
      expect(item.earned).toBeLessThanOrEqual(item.weight);
    }
  });

  it("scores a scanned, image-only PDF near zero", async () => {
    const scanPath = path.join(directory, "scan.pdf");
    await writeFile(scanPath, buildScannedPdf());
    const report = await scoreAtsComplianceForPdf(scanPath);
    expect(report.score).toBeLessThanOrEqual(10);
    expect(report.passed).toBe(false);
    expect(findings(report, "text")).toContain("no usable text layer");
  });

  it("rejects a file that is not a PDF", async () => {
    const bogus = path.join(directory, "not-a.pdf");
    await writeFile(bogus, "plain text, not a pdf at all");
    await expect(scoreAtsComplianceForPdf(bogus)).rejects.toBeInstanceOf(
      PdfTextExtractionError,
    );
  });
});
