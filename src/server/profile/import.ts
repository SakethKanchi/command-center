/**
 * Turn an uploaded resume file into plain text.
 *
 * Text only: the structured pass over that text lives in `./extract`. Keeping
 * them apart means a parser that produces garbage is diagnosable without a
 * model call, and the model never sees a file it could not read.
 *
 * Both parsers are pure JavaScript on purpose — `unpdf` for PDF and `fflate`
 * for the DOCX zip. A native PDF or zip binding would put a compiler in the
 * install path of an app whose whole storage layer was chosen to avoid one.
 */

import { AppError, badRequest } from "@server/infra/errors";
import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

export type ResumeFile = { name: string; bytes: Uint8Array };

export type ExtractedResumeText = { text: string; warnings: string[] };

const BYTES_PER_MB = 1024 * 1024;

/**
 * A real resume is tens of kilobytes. The cap is there to stop a 200 MB scan
 * from being decompressed in memory, not to be generous.
 */
export const MAX_RESUME_IMPORT_MB = 5;
export const MAX_RESUME_IMPORT_BYTES = MAX_RESUME_IMPORT_MB * BYTES_PER_MB;

/**
 * Extension is authoritative. Browsers send an empty or wrong MIME type for
 * `.md` routinely, and a MIME type is caller-supplied either way.
 */
export const SUPPORTED_RESUME_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
] as const;

/** Derived so the rejection message cannot drift from the list above. */
const ACCEPTED_PHRASE = `${SUPPORTED_RESUME_EXTENSIONS.slice(0, -1).join(", ")} and ${SUPPORTED_RESUME_EXTENSIONS.at(-1)}`;

/**
 * Below this, a PDF carried pages but no readable glyphs, which in practice
 * means the pages are images of a resume. Set well under the length of the
 * shortest plausible real resume so a terse one-pager is not accused.
 */
const MIN_PDF_TEXT_CHARS = 200;

/** The only part of a `.docx` that holds body text. */
const DOCX_BODY = "word/document.xml";

async function readPdf(file: ResumeFile): Promise<ExtractedResumeText> {
  // pdfjs takes ownership of the buffer it is handed, and the route still
  // needs the caller's bytes afterwards to report the upload size.
  const pdf = await getDocumentProxy(new Uint8Array(file.bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const cleaned = text.replace(/\r\n?/g, "\n").trim();

  if (cleaned.length >= MIN_PDF_TEXT_CHARS) {
    return { text: cleaned, warnings: [] };
  }

  // Returning what was actually recovered, rather than an empty draft, is the
  // difference between "this file needs OCR or a text export" and a blank form
  // the user cannot explain.
  return {
    text: cleaned,
    warnings: [
      `"${file.name}" has ${totalPages} page(s) but only ${cleaned.length} ` +
        "characters of extractable text, so it looks like a scan or an " +
        "image-only PDF. Export a text PDF, or fill the fields in by hand.",
    ],
  };
}

/** Block-level tags whose boundaries are the only line structure OOXML has. */
const DOCX_BREAKS: Array<[RegExp, string]> = [
  [/<\/w:p>/g, "\n"],
  [/<w:br\b[^>]*\/?>/g, "\n"],
  [/<w:tab\b[^>]*\/?>/g, "\t"],
];

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

const XML_ENTITY = /&[a-z]+;|&#x?[0-9a-f]+;/gi;

function decodeEntity(entity: string): string {
  const named = XML_ENTITIES[entity.toLowerCase()];
  if (named !== undefined) return named;

  const numeric = /^&#(x?)([0-9a-f]+);$/i.exec(entity);
  const digits = numeric?.[2];
  if (digits === undefined) return entity;
  const code = Number.parseInt(digits, numeric?.[1] === "" ? 10 : 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

function readDocx(file: ResumeFile): ExtractedResumeText {
  const entries = unzipSync(file.bytes, {
    filter: (entry) => entry.name === DOCX_BODY,
  });
  const body = entries[DOCX_BODY];
  if (body === undefined) {
    throw badRequest(
      `"${file.name}" is not a Word document: it contains no ${DOCX_BODY}. ` +
        "If it was renamed from .doc or .pages, export it as .docx or .pdf.",
      { fileName: file.name },
    );
  }

  let xml = new TextDecoder("utf-8").decode(body);
  for (const [pattern, replacement] of DOCX_BREAKS) {
    xml = xml.replace(pattern, replacement);
  }

  const text = xml
    .replace(/<[^>]*>/g, "")
    .replace(XML_ENTITY, decodeEntity)
    // OOXML indents its own markup, so stripping tags leaves that indentation
    // on every line, and each paragraph close has already emitted the newline
    // the source file also contains. Both are markup artefacts, not content.
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return { text, warnings: [] };
}

/**
 * Read an uploaded resume as text.
 *
 * Every rejection is a `badRequest` carrying a full sentence: the file name,
 * what was wrong, and what would work instead. The upload form renders that
 * message verbatim, so "invalid file" is not an acceptable answer.
 */
export async function extractResumeText(
  file: ResumeFile,
): Promise<ExtractedResumeText> {
  if (file.bytes.length === 0) {
    throw badRequest(`"${file.name}" is empty — nothing to import.`, {
      fileName: file.name,
    });
  }
  if (file.bytes.length > MAX_RESUME_IMPORT_BYTES) {
    throw badRequest(
      `"${file.name}" is ${(file.bytes.length / BYTES_PER_MB).toFixed(1)} MB, ` +
        `over the ${MAX_RESUME_IMPORT_MB} MB import limit.`,
      {
        fileName: file.name,
        bytes: file.bytes.length,
        limit: MAX_RESUME_IMPORT_BYTES,
      },
    );
  }

  const lower = file.name.toLowerCase();
  const extension =
    SUPPORTED_RESUME_EXTENSIONS.find((candidate) =>
      lower.endsWith(candidate),
    ) ?? null;
  if (extension === null) {
    throw badRequest(
      `Cannot read "${file.name}": only ${ACCEPTED_PHRASE} resumes can be ` +
        "imported.",
      { fileName: file.name, accepted: [...SUPPORTED_RESUME_EXTENSIONS] },
    );
  }

  try {
    if (extension === ".pdf") return await readPdf(file);
    if (extension === ".docx") return readDocx(file);

    const text = new TextDecoder("utf-8")
      .decode(file.bytes)
      .replace(/\r\n?/g, "\n")
      .trim();
    return {
      text,
      warnings: text === "" ? [`"${file.name}" contained no text.`] : [],
    };
  } catch (error) {
    // Already a named, actionable rejection — re-wrapping would bury it.
    if (error instanceof AppError) throw error;
    // A parser blowing up on a corrupt file is a bad upload, not a server
    // fault, and the user can only act on it if the file is named.
    throw badRequest(
      `Could not read "${file.name}" as ${extension}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { fileName: file.name, extension },
    );
  }
}
