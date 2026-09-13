/**
 * Render a resume PDF with Typst.
 *
 * Typst is a single static binary that compiles a plain-text template against a
 * JSON data file in well under a second, with no browser and no font download.
 * The selected template and the shared body it imports are copied into a
 * throwaway directory next to the serialized profile and compiled with `--root`
 * pinned to that directory, so a hostile profile value cannot make the compiler
 * read anything else on the disk, and the binary is invoked with an argv array
 * so nothing in the profile reaches a shell.
 *
 * Only ids from the `@domain` catalogue resolve to a file. The template is
 * never a path from the caller, which is what keeps the copy step from being a
 * file-read primitive.
 */

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RESUME_TEMPLATE,
  isResumeTemplateId,
  type Profile,
  RESUME_TEMPLATES,
  type ResumeTemplateId,
  type SkillGroup,
} from "@domain";
import { badRequest, upstreamError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";

const TEMPLATE_DIR = fileURLToPath(new URL("./templates/", import.meta.url));
/** Imported by every template; copied alongside whichever one was chosen. */
const SHARED_TEMPLATE = "common.typ";

const COMPILE_TIMEOUT_MS = 30_000;
/** Typst diagnostics are short; a runaway stream is still bounded. */
const MAX_STDERR_CHARS = 16_000;

const INSTALL_HINT =
  "Install Typst (`curl -fsSL https://typst.community/typst-install/install.sh | sh`, `brew install typst`, or `cargo install --locked typst-cli`) or point TYPST_BIN at its absolute path.";

/** The three fields a tailoring pass may override, all optional. */
export type TailoredResume = {
  headline?: string | null;
  summary?: string | null;
  skills?: SkillGroup[] | null;
};

export type RenderResumeInput = {
  profile: Profile;
  tailored?: TailoredResume;
  outputPath: string;
  /** A catalogue id; anything else is a 400. Omitted means the default. */
  template?: ResumeTemplateId;
  typstBin?: string;
};

export type RenderedResume = {
  pdfPath: string;
  pageCount: number;
  /** Which template produced this file, resolved default included. */
  template: ResumeTemplateId;
};

/** Explicit override, then `TYPST_BIN`, then whatever is on `PATH`. */
function resolveTypstBin(override?: string): string {
  const explicit = override?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = process.env.TYPST_BIN?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "typst";
}

/**
 * Catalogue id to file name. An unknown id is the caller's bug and is reported
 * as one, with the valid ids listed — silently falling back to the default
 * would mean a user picked "classic" and got something else.
 */
function resolveTemplate(id?: ResumeTemplateId): {
  template: ResumeTemplateId;
  file: string;
} {
  const template = id ?? DEFAULT_RESUME_TEMPLATE;
  if (!isResumeTemplateId(template)) {
    throw badRequest(`Unknown resume template "${String(template)}".`, {
      templates: RESUME_TEMPLATES.map((entry) => entry.id),
    });
  }
  return { template, file: path.join(TEMPLATE_DIR, `${template}.typ`) };
}

/**
 * The profile with the tailoring pass applied. A blank or absent override falls
 * back to the profile, so a model that returned an empty string cannot silently
 * blank out a section of the resume.
 */
export function effectiveResume(
  profile: Profile,
  tailored?: TailoredResume,
): Profile {
  const headline = tailored?.headline?.trim();
  const summary = tailored?.summary?.trim();
  const skills = tailored?.skills;
  return {
    ...profile,
    headline:
      headline !== undefined && headline !== "" ? headline : profile.headline,
    summary:
      summary !== undefined && summary !== "" ? summary : profile.summary,
    skills:
      skills !== undefined && skills !== null && skills.length > 0
        ? skills
        : profile.skills,
  };
}

type CompileResult = { code: number | null; stderr: string };

function runTypst(
  bin: string,
  args: string[],
  cwd: string,
): Promise<CompileResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CompileResult>();
  const child = spawn(bin, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMPILE_TIMEOUT_MS,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
  });
  // Drained rather than ignored: an unread pipe stalls the child once full.
  child.stdout.resume();
  child.on("error", reject);
  child.on("close", (code) => {
    resolve({ code, stderr: stderr.trim() });
  });
  return promise;
}

/**
 * Page count read back out of the produced file, counting `/Type /Page` object
 * dictionaries. Typst writes them uncompressed; a build that stops doing so is
 * a loud failure here rather than a quietly wrong number downstream.
 */
function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches === null ? 0 : matches.length;
}

export async function renderResumePdf(
  input: RenderResumeInput,
): Promise<RenderedResume> {
  const outputPath = path.resolve(input.outputPath);
  if (!outputPath.toLowerCase().endsWith(".pdf")) {
    throw badRequest(
      `renderResumePdf expects a .pdf outputPath, got ${input.outputPath}`,
    );
  }
  const bin = resolveTypstBin(input.typstBin);
  const { template, file } = resolveTemplate(input.template);
  const resume = effectiveResume(input.profile, input.tailored);

  await mkdir(path.dirname(outputPath), { recursive: true });
  const workDir = await mkdtemp(path.join(tmpdir(), "command-center-resume-"));
  const startedAt = Date.now();
  try {
    const entry = path.join(workDir, "resume.typ");
    await Promise.all([
      writeFile(
        path.join(workDir, "resume.json"),
        JSON.stringify(resume),
        "utf8",
      ),
      copyFile(file, entry),
      copyFile(
        path.join(TEMPLATE_DIR, SHARED_TEMPLATE),
        path.join(workDir, SHARED_TEMPLATE),
      ),
    ]);

    let result: CompileResult;
    try {
      result = await runTypst(
        bin,
        ["compile", "--root", workDir, entry, outputPath],
        workDir,
      );
    } catch (error) {
      // `spawn` reports a missing executable as an ENOENT error event.
      const missingBinary =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT";
      if (missingBinary) {
        throw badRequest(
          `Typst binary "${bin}" was not found. ${INSTALL_HINT}`,
          { typstBin: bin },
        );
      }
      throw upstreamError(`Typst could not be started: ${String(error)}`, {
        typstBin: bin,
      });
    }

    if (result.code !== 0) {
      throw upstreamError(
        `Typst failed to compile the resume with the ${template} template (exit ${result.code ?? "signal"})`,
        { typstBin: bin, template, stderr: result.stderr },
      );
    }

    const pdf = await readFile(outputPath);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-", "latin1"))) {
      throw upstreamError("Typst produced a file that is not a PDF", {
        outputPath,
      });
    }
    const pageCount = countPdfPages(pdf);
    if (pageCount < 1) {
      throw upstreamError("Rendered resume reports no pages", { outputPath });
    }

    logger.info("resume rendered", {
      outputPath,
      template,
      pageCount,
      bytes: pdf.byteLength,
      durationMs: Date.now() - startedAt,
    });
    return { pdfPath: outputPath, pageCount, template };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
