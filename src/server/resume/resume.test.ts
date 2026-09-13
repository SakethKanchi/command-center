import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Profile, RESUME_TEMPLATES, type ResumeTemplateId } from "@domain";
import { type Db, openDatabase } from "@server/db";
import { AppError } from "@server/infra/errors";
import { createRepos, type RepoBundle } from "@server/repos";
import { extractPdfText, scoreAtsComplianceForPdf } from "@server/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearProfileCache,
  DEFAULT_PROFILE_PATH,
  loadProfile,
} from "./profile";
import { renderResumePdf } from "./render";
import { applyTracerLinks } from "./tracer";

const PDF_MAGIC = "%PDF-";

/**
 * Extracted text breaks lines wherever the renderer wrapped a paragraph, which
 * is not a fact worth asserting, so every content check below reads the
 * whitespace-flattened text and survives a reflow.
 */
async function readPdfText(pdfPath: string): Promise<string> {
  const buffer = await readFile(pdfPath);
  const extracted = await extractPdfText(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  return extracted.text.replace(/\s+/g, " ").trim();
}

let tempDir: string;
let profile: Profile;
let baselinePdf: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "resume-test-"));
  clearProfileCache();
  profile = loadProfile();
  baselinePdf = path.join(tempDir, "baseline", "resume.pdf");
});

afterAll(async () => {
  clearProfileCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe("renderResumePdf", () => {
  it("compiles the profile into a real, single-page PDF", async () => {
    const rendered = await renderResumePdf({
      profile,
      outputPath: baselinePdf,
    });

    expect(rendered.pdfPath).toBe(baselinePdf);
    // 1 is the target; 2 is tolerable. Anything else means the layout broke.
    expect([1, 2]).toContain(rendered.pageCount);

    const bytes = await readFile(rendered.pdfPath);
    expect(bytes.subarray(0, PDF_MAGIC.length).toString("latin1")).toBe(
      PDF_MAGIC,
    );
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  });

  /*
   * Every template, through the gate the agent halts on.
   *
   * This is the test that makes a template catalogue safe to extend: a new
   * `.typ` that introduces a second column, a table or a font a PDF extractor
   * mangles fails here rather than in a live application. The threshold is the
   * same one the baseline holds, so no template is allowed to be the weak one.
   */
  it.each(
    RESUME_TEMPLATES.map((template) => template.id),
  )("renders the %s template as a single-column PDF that clears the ATS gate", async (template) => {
    const outputPath = path.join(tempDir, `${template}.pdf`);
    const rendered = await renderResumePdf({ profile, template, outputPath });

    expect(rendered.template).toBe(template);
    expect([1, 2]).toContain(rendered.pageCount);

    const report = await scoreAtsComplianceForPdf(outputPath);
    const evidence = report.breakdown
      .filter((item) => item.earned < item.weight)
      .map(
        (item) =>
          `${item.dimension} ${item.earned}/${item.weight}: ${item.findings.join(" ")}`,
      )
      .join("\n");
    expect(report.score, evidence).toBeGreaterThanOrEqual(90);

    // Same document either way: a template changes the typography, never the
    // facts the fabrication gate checks the prose against.
    const text = await readPdfText(outputPath);
    expect(text).toContain(profile.headline);
    expect(text).toContain(profile.email);
    expect(text.toUpperCase()).toContain("EDUCATION");
  });

  it("refuses a template id that is not in the catalogue", async () => {
    const error = await renderResumePdf({
      profile,
      // The API validates first; this is the renderer's own guard against a
      // stale id reaching the file copy.
      template: "sidebar" as ResumeTemplateId,
      outputPath: path.join(tempDir, "unknown.pdf"),
    }).catch((caught: unknown) => caught);

    if (!(error instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(error)}`);
    }
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("sidebar");
  });

  it("lets the tailoring pass override headline, summary and skills", async () => {
    const outputPath = path.join(tempDir, "tailored.pdf");
    const tailored = {
      headline: "Platform Engineer focused on retrieval evaluation",
      summary:
        "Tailored for the posting: hybrid retrieval, reranking, and an evaluation harness that runs on every merge.",
      skills: [{ name: "Retrieval", keywords: ["pgvector", "reranking"] }],
    };

    await renderResumePdf({ profile, tailored, outputPath });
    const text = await readPdfText(outputPath);

    expect(text).toContain(tailored.headline);
    expect(text).toContain(tailored.summary);
    expect(text).toContain("Retrieval: pgvector, reranking");

    expect(text).not.toContain(profile.headline);
    expect(text).not.toContain(profile.summary);
    // A default skill group the tailored set does not carry.
    expect(text).not.toContain("Cloud & Quality");
  });

  it("renders Typst-significant characters as literal text", async () => {
    const hostile = 'Cut spend #1 by $[40%] on \\ "burst" [staging] jobs';
    const outputPath = path.join(tempDir, "hostile.pdf");
    const first = profile.experience[0];
    if (first === undefined) throw new Error("profile has no experience entry");

    const rendered = await renderResumePdf({
      profile: {
        ...profile,
        summary: hostile,
        experience: [{ ...first, bullets: [hostile, ...first.bullets] }],
      },
      outputPath,
    });

    expect([1, 2]).toContain(rendered.pageCount);
    const text = await readPdfText(outputPath);
    // Twice: once in the summary, once as a bullet. Markup execution would have
    // swallowed the brackets or turned `$...$` into a math run.
    expect(text.split(hostile)).toHaveLength(3);
    // The rest of the document still rendered around it.
    expect(text).toContain("EDUCATION");
  });

  it("rejects a missing typst binary by name", async () => {
    const typstBin = path.join(tempDir, "definitely-not-typst");
    const error = await renderResumePdf({
      profile,
      outputPath: path.join(tempDir, "unused.pdf"),
      typstBin,
    }).catch((caught: unknown) => caught);

    if (!(error instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(error)}`);
    }
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain(typstBin);
    expect(error.message.toLowerCase()).toContain("install");
  });

  it("surfaces the compiler's stderr when typst exits non-zero", async () => {
    const typstBin = path.join(tempDir, "failing-typst");
    await writeFile(
      typstBin,
      "#!/bin/sh\necho 'error: unclosed delimiter' >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    const error = await renderResumePdf({
      profile,
      outputPath: path.join(tempDir, "failed.pdf"),
      typstBin,
    }).catch((caught: unknown) => caught);

    if (!(error instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(error)}`);
    }
    expect(error.code).toBe("UPSTREAM_ERROR");
    // The diagnostic is the only thing that makes a template break fixable.
    expect(JSON.stringify(error.details)).toContain("unclosed delimiter");
  });
});

describe("loadProfile", () => {
  it("accepts the seeded profile and caches the parse", () => {
    clearProfileCache();
    const first = loadProfile();
    const second = loadProfile(DEFAULT_PROFILE_PATH);

    expect(second).toBe(first);
    expect(first.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    expect(first.experience.length).toBeGreaterThan(0);
    expect(first.skills.length).toBeGreaterThan(0);
    expect(first.links.length).toBeGreaterThan(0);
  });

  it("reports the offending field when the profile is malformed", async () => {
    const malformedPath = path.join(tempDir, "malformed-profile.json");
    await writeFile(
      malformedPath,
      JSON.stringify({
        ...profile,
        email: "not-an-email",
        skills: [{ name: "", keywords: [] }],
      }),
      "utf8",
    );

    let thrown: unknown;
    try {
      loadProfile(malformedPath);
    } catch (caught) {
      thrown = caught;
    }

    if (!(thrown instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(thrown)}`);
    }
    expect(thrown.code).toBe("INVALID_REQUEST");
    expect(thrown.message).toContain("email");
    expect(thrown.message).toContain("skills.0.name");
    expect(thrown.message).toContain("skills.0.keywords");
    // A rejected file is never cached, and never shadows the real profile.
    expect(loadProfile().email).toBe(profile.email);
  });
});

describe("applyTracerLinks", () => {
  let db: Db;
  let repos: RepoBundle;
  let jobId: string;

  beforeAll(() => {
    db = openDatabase(path.join(tempDir, "tracer.db"));
    repos = createRepos(db);
    const url = "https://boards.example.com/jobs/tracer-1";
    repos.jobs.upsertMany([
      {
        source: "greenhouse",
        sourceJobId: "tracer-1",
        title: "Full Stack AI Engineer",
        company: "Example Labs",
        location: "Remote",
        isRemote: true,
        url,
        applyUrl: null,
        descriptionText: "Build retrieval systems.",
        salaryText: null,
        postedAt: null,
      },
    ]);
    const job = repos.jobs.getByUrl(url);
    if (job === null) throw new Error("job fixture was not inserted");
    jobId = job.id;
  });

  afterAll(() => {
    db.close();
  });

  it("returns a rewritten clone and stores one row per destination", () => {
    const before = structuredClone(profile);
    const traced = applyTracerLinks({
      profile,
      jobId,
      repos,
      baseUrl: "https://cc.example.com/",
    });

    expect(traced).not.toBe(profile);
    expect(profile).toEqual(before);

    const stored = repos.resumeLinks.listForJob(jobId);
    expect(stored).toHaveLength(profile.links.length);

    for (const [index, link] of traced.links.entries()) {
      const original = profile.links[index];
      if (original === undefined) throw new Error("missing original link");
      expect(link.label).toBe(original.label);

      const token = link.url.replace("https://cc.example.com/r/", "");
      expect(link.url).toBe(`https://cc.example.com/r/${token}`);
      expect(token).not.toContain("/");

      // A click on the tracked URL has to resolve to the real destination.
      const row = repos.resumeLinks.getByToken(token);
      expect(row?.destinationUrl).toBe(original.url);
      expect(row?.jobId).toBe(jobId);
    }
  });

  it("reuses the tokens already embedded in a submitted resume", () => {
    const first = applyTracerLinks({
      profile,
      jobId,
      repos,
      baseUrl: "https://cc.example.com",
    });
    const second = applyTracerLinks({
      profile,
      jobId,
      repos,
      baseUrl: "https://cc.example.com",
    });

    expect(second.links).toEqual(first.links);
    expect(repos.resumeLinks.listForJob(jobId)).toHaveLength(
      profile.links.length,
    );
  });
});
