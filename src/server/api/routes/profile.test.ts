import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileCompleteness, ProfileDraft } from "@domain";
import { respondWithError } from "@server/api/respond";
import { createProfileRoutes } from "@server/api/routes/profile";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos, type RepoBundle } from "@server/repos";
import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;
let app: Hono;

const RESUME_TEXT = [
  "Grace Hopper",
  "grace@example.test | (555) 010-7788 | Arlington, VA",
  "",
  "SUMMARY",
  "Compiler pioneer working on machine-independent programming languages.",
  "",
  "EXPERIENCE",
  "Eckert-Mauchly — Senior Mathematician — Philadelphia, PA — 1949 to 1959",
  "- Built the first compiler, A-0, and the toolchain around it.",
  "- Led the team that produced FLOW-MATIC, the basis for COBOL.",
  "",
  "PROJECTS",
  "A-0 — first compiler — github.com/gracehopper/a0",
  "- Translated symbolic subroutine calls into machine code.",
  "",
  "EDUCATION",
  "Yale University — PhD Mathematics — 1934",
].join("\n");

/** What a faithful extraction of `RESUME_TEXT` looks like. */
const EXTRACTED = {
  name: "Grace Hopper",
  headline: "Senior Mathematician",
  email: "grace@example.test",
  phone: "(555) 010-7788",
  location: "Arlington, VA",
  summary:
    "Compiler pioneer working on machine-independent programming languages.",
  links: [],
  skills: [{ name: "Skills", keywords: ["Compilers", "COBOL"] }],
  roles: [
    {
      company: "Eckert-Mauchly",
      title: "Senior Mathematician",
      location: "Philadelphia, PA",
      startDate: "1949",
      endDate: "1959",
      bullets: [
        "Built the first compiler, A-0, and the toolchain around it.",
        "Led the team that produced FLOW-MATIC, the basis for COBOL.",
      ],
    },
  ],
  projects: [
    {
      name: "A-0",
      description: "first compiler",
      url: "https://github.com/gracehopper/a0",
      bullets: ["Translated symbolic subroutine calls into machine code."],
    },
  ],
  education: [
    {
      school: "Yale University",
      credential: "PhD Mathematics",
      location: null,
      startDate: null,
      endDate: "1934",
    },
  ],
};

let llmPayload: unknown = EXTRACTED;

const llm: LlmClient = {
  model: "stub-model",
  completeJson: async <T>() => llmPayload as T,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-profile-routes-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
  llmPayload = EXTRACTED;

  // Mounted exactly as the server mounts it, so the tested paths are the real
  // ones and the error envelope is the shared one.
  app = new Hono();
  app.onError(respondWithError);
  app.route(
    "/api",
    createProfileRoutes({ repos, llm, baseUrl: "http://localhost:8787" }),
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type GetBody = {
  profile: ProfileDraft;
  source: "stored" | "seed";
  completeness: ProfileCompleteness;
};

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: boolean; data: T };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

async function errorOf(
  response: Response,
): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(body.ok).toBe(false);
  return body.error;
}

async function upload(name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  // `slice()` hands the File a copy backed by a plain ArrayBuffer, which is
  // what `BlobPart` accepts.
  form.set("file", new File([bytes.slice()], name));
  return app.request("/api/profile/import", { method: "POST", body: form });
}

async function save(draft: ProfileDraft): Promise<Response> {
  return app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
}

describe("GET /api/profile", () => {
  it("answers from the committed seed before anything is saved", async () => {
    const data = await unwrap<GetBody>(await app.request("/api/profile"));

    expect(data.source).toBe("seed");
    // The seed is a real, renderable profile: a fresh clone can generate a
    // resume without anyone filling the form in first.
    expect(data.completeness.ready).toBe(true);
    expect(data.profile.name).not.toBe("");
    expect(data.profile.roles.length).toBeGreaterThan(0);
  });
});

describe("import -> PUT -> GET", () => {
  it("round-trips an imported resume through save and read", async () => {
    const imported = await unwrap<{
      draft: ProfileDraft;
      warnings: string[];
      extractedChars: number;
      fileName: string;
    }>(await upload("grace.txt", strToU8(RESUME_TEXT)));

    expect(imported.fileName).toBe("grace.txt");
    expect(imported.extractedChars).toBe(RESUME_TEXT.length);
    expect(imported.warnings).toEqual([]);
    // Import proposes; it must not have written anything.
    expect(repos.profile.get()).toBeNull();

    // The draft an import produced is accepted verbatim — no massaging.
    const saved = await unwrap<{
      profile: ProfileDraft;
      completeness: ProfileCompleteness;
    }>(await save(imported.draft));
    expect(saved.profile).toEqual(imported.draft);
    expect(saved.completeness.ready).toBe(true);

    const read = await unwrap<GetBody>(await app.request("/api/profile"));
    expect(read.source).toBe("stored");
    expect(read.profile).toEqual(imported.draft);
    // Nested structure survives the JSON columns, not just the scalars.
    expect(read.profile.roles[0]?.bullets).toEqual([
      "Built the first compiler, A-0, and the toolchain around it.",
      "Led the team that produced FLOW-MATIC, the basis for COBOL.",
    ]);
    expect(read.profile.skills[0]?.keywords).toEqual(["Compilers", "COBOL"]);
    expect(read.profile.education[0]?.credential).toBe("PhD Mathematics");
    expect(read.profile.phone).toBe("(555) 010-7788");
  });

  it("imports a .docx as readily as a .txt", async () => {
    const xml =
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>` +
      RESUME_TEXT.split("\n")
        .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
        .join("") +
      `</w:body></w:document>`;
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(xml),
    });

    const imported = await unwrap<{ draft: ProfileDraft }>(
      await upload("grace.docx", docx),
    );

    expect(imported.draft.name).toBe("Grace Hopper");
    expect(imported.draft.roles[0]?.company).toBe("Eckert-Mauchly");
  });

  it("returns the anti-fabrication warning with the draft it cleaned", async () => {
    llmPayload = { ...EXTRACTED, email: "grace.hopper@gmail.com" };

    const imported = await unwrap<{
      draft: ProfileDraft;
      warnings: string[];
    }>(await upload("grace.txt", strToU8(RESUME_TEXT)));

    expect(imported.draft.email).toBe("");
    expect(imported.warnings.join(" ")).toContain("grace.hopper@gmail.com");

    // The cleaned draft is still savable, and completeness names the hole the
    // dropped address left behind.
    const saved = await unwrap<{ completeness: ProfileCompleteness }>(
      await save(imported.draft),
    );
    expect(saved.completeness.ready).toBe(false);
    expect(saved.completeness.missing).toContain("email");
  });

  it("rejects an unsupported file type, naming what is accepted", async () => {
    const error = await errorOf(
      await upload("grace.pages", strToU8("Grace Hopper")),
    );

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("grace.pages");
    expect(error.message).toContain(".docx");
  });

  it("rejects a request with no file field", async () => {
    const form = new FormData();
    form.set("resume", new File([strToU8("x")], "grace.txt"));
    const error = await errorOf(
      await app.request("/api/profile/import", {
        method: "POST",
        body: form,
      }),
    );

    expect(error.message).toContain("file");
  });
});

describe("PUT /api/profile", () => {
  it("saves a half-finished draft and reports what is still missing", async () => {
    // The editor autosaves; refusing an incomplete profile would make the form
    // unusable until it was perfect.
    const data = await unwrap<{
      profile: ProfileDraft;
      completeness: ProfileCompleteness;
    }>(
      await save({
        name: "Grace Hopper",
        headline: "",
        email: "grace@example.test",
        phone: null,
        location: null,
        links: [],
        summary: "",
        skills: [],
        roles: [],
        projects: [],
        education: [],
      }),
    );

    expect(data.completeness.ready).toBe(false);
    expect(data.completeness.missing).toContain("headline");
    expect(data.completeness.missing).toContain("summary");
    expect(data.completeness.score).toBeGreaterThan(0);

    const read = await unwrap<GetBody>(await app.request("/api/profile"));
    expect(read.source).toBe("stored");
    expect(read.profile.name).toBe("Grace Hopper");
  });

  it("names the offending field when a value is the wrong shape", async () => {
    const error = await errorOf(
      await app.request("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...EXTRACTED,
          roles: [{ ...EXTRACTED.roles[0], bullets: "not an array" }],
        }),
      }),
    );

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("roles.0.bullets");
  });

  it("rejects an email that is not an email", async () => {
    const error = await errorOf(
      await save({ ...EXTRACTED, email: "not-an-address" } as ProfileDraft),
    );

    expect(error.message).toContain("email");
  });
});

describe("/api/profile/role-suggestions", () => {
  const SUGGESTED = {
    suggestions: [
      {
        title: "Compiler Engineer",
        query: "compiler engineer",
        reason: "Built A-0 at Eckert-Mauchly.",
      },
      {
        title: "Compiler Engineer",
        query: "Compiler Engineer",
        reason: "Duplicate of the first, differing only in case.",
      },
      { title: "", query: "language design", reason: "No title." },
    ],
  };

  async function suggestions(method: "GET" | "POST"): Promise<Response> {
    return app.request("/api/profile/role-suggestions", { method });
  }

  it("suggests nothing until a resume has been saved", async () => {
    const data = await unwrap<{
      suggestions: unknown[];
      profileSource: string;
      stale: boolean;
    }>(await suggestions("GET"));

    expect(data.profileSource).toBe("seed");
    expect(data.suggestions).toEqual([]);
    // Nothing to be stale against: the seed is not the user's resume.
    expect(data.stale).toBe(false);

    const error = await errorOf(await suggestions("POST"));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("resume");
  });

  it("generates against the saved profile, then serves it without a model call", async () => {
    await save(EXTRACTED as ProfileDraft);

    const stale = await unwrap<{ stale: boolean }>(await suggestions("GET"));
    expect(stale.stale).toBe(true);

    llmPayload = SUGGESTED;
    const generated = await unwrap<{
      suggestions: Array<{ title: string; query: string }>;
      generatedAt: string | null;
      stale: boolean;
    }>(await suggestions("POST"));

    // The duplicate and the title-less row are dropped before storage.
    expect(generated.suggestions).toEqual([
      {
        title: "Compiler Engineer",
        query: "compiler engineer",
        reason: "Built A-0 at Eckert-Mauchly.",
      },
    ]);
    expect(generated.stale).toBe(false);
    expect(generated.generatedAt).not.toBeNull();

    // A model call now would return something else; the read must not make one.
    llmPayload = { suggestions: [] };
    const read = await unwrap<{
      suggestions: Array<{ title: string }>;
      stale: boolean;
    }>(await suggestions("GET"));
    expect(read.suggestions[0]?.title).toBe("Compiler Engineer");
    expect(read.stale).toBe(false);
  });

  it("goes stale when the resume changes, but not when a phone number does", async () => {
    await save(EXTRACTED as ProfileDraft);
    llmPayload = SUGGESTED;
    await suggestions("POST");

    await save({ ...EXTRACTED, phone: "(555) 010-0000" } as ProfileDraft);
    const contact = await unwrap<{ stale: boolean }>(await suggestions("GET"));
    expect(contact.stale).toBe(false);

    await save({ ...EXTRACTED, headline: "Rear Admiral" } as ProfileDraft);
    const rewritten = await unwrap<{
      stale: boolean;
      suggestions: Array<{ title: string }>;
    }>(await suggestions("GET"));
    expect(rewritten.stale).toBe(true);
    // Still served: last week's answer beats a blank row while a refresh runs.
    expect(rewritten.suggestions[0]?.title).toBe("Compiler Engineer");
  });
});
