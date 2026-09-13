import { AppError } from "@server/infra/errors";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractResumeText,
  MAX_RESUME_IMPORT_BYTES,
  type ResumeFile,
} from "./import";

/**
 * A minimal single-page PDF that really parses, built rather than committed so
 * the amount of text on the page is a parameter of the test. `unpdf` is doing
 * the reading either way; what is under test is what this module does with the
 * result.
 */
function buildPdf(lines: string[]): Uint8Array {
  const ops = ["BT", "/F1 11 Tf", "72 720 Td", "14 TL"];
  for (const line of lines) {
    ops.push(`(${line.replace(/([()\\])/g, "\\$1")}) Tj`, "T*");
  }
  ops.push("ET");
  const content = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;

  return strToU8(pdf);
}

function buildDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(
      (text) =>
        `  <w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>` +
        `<w:r><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("\n");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n` +
    `  <w:body>\n${body}\n  </w:body>\n</w:document>`;

  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(xml),
  });
}

async function rejection(file: ResumeFile): Promise<AppError> {
  try {
    await extractResumeText(file);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected extractResumeText to reject");
}

describe("extractResumeText", () => {
  it("reads a .docx as one line per paragraph", async () => {
    const result = await extractResumeText({
      name: "ada.docx",
      bytes: buildDocx([
        "Ada Lovelace",
        "ada@example.com",
        "Punch &amp; Cards &#8212; Analytical Engines",
      ]),
    });

    // OOXML indentation and the markup's own line breaks are artefacts; what
    // the user typed is three lines, and entities are real characters.
    expect(result.text).toBe(
      "Ada Lovelace\nada@example.com\nPunch & Cards — Analytical Engines",
    );
    expect(result.warnings).toEqual([]);
  });

  it("reads a .txt and normalises CRLF", async () => {
    const result = await extractResumeText({
      name: "ada.txt",
      bytes: strToU8("Ada Lovelace\r\nada@example.com\r\n"),
    });

    expect(result.text).toBe("Ada Lovelace\nada@example.com");
    expect(result.warnings).toEqual([]);
  });

  it("reads a .md", async () => {
    const result = await extractResumeText({
      name: "ada.md",
      bytes: strToU8("# Ada Lovelace\n\n- Built the first program\n"),
    });

    expect(result.text).toBe("# Ada Lovelace\n\n- Built the first program");
  });

  it("reads a text-bearing PDF without complaint", async () => {
    const result = await extractResumeText({
      name: "ada.pdf",
      bytes: buildPdf([
        "Ada Lovelace - Analytical Engine Programmer",
        "ada@example.com | +1 (555) 010-1234 | London",
        "Wrote the first published algorithm intended for a machine,",
        "including the notes that describe looping and subroutines.",
        "Skills: Analysis, Mathematics, Technical Writing, Notation",
      ]),
    });

    expect(result.text).toContain("Ada Lovelace");
    expect(result.text).toContain("ada@example.com");
    expect(result.warnings).toEqual([]);
  });

  it("reports a text-free PDF as a scan instead of an empty success", async () => {
    // A page with almost no extractable text is a photographed resume. The
    // user has to be told that, or they see a blank form and no reason for it.
    const result = await extractResumeText({
      name: "photo.pdf",
      bytes: buildPdf(["Ada"]),
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("photo.pdf");
    expect(result.warnings[0]).toMatch(/scan|image-only/);
    expect(result.text).toBe("Ada");
  });

  it("rejects an unsupported extension, naming what is accepted", async () => {
    const error = await rejection({
      name: "resume.pages",
      bytes: strToU8("Ada Lovelace"),
    });

    expect(error.status).toBe(400);
    expect(error.message).toContain("resume.pages");
    expect(error.message).toContain(".pdf");
    expect(error.message).toContain(".docx");
    expect(error.message).toContain(".txt");
    expect(error.message).toContain(".md");
  });

  it("rejects a file over the size limit, naming the limit", async () => {
    const error = await rejection({
      name: "huge.pdf",
      bytes: new Uint8Array(MAX_RESUME_IMPORT_BYTES + 1),
    });

    expect(error.status).toBe(400);
    expect(error.message).toContain("huge.pdf");
    expect(error.message).toContain("5 MB");
  });

  it("rejects an empty file", async () => {
    const error = await rejection({
      name: "blank.txt",
      bytes: new Uint8Array(0),
    });

    expect(error.message).toContain("blank.txt");
  });

  it("turns a corrupt file into a named 400 rather than a crash", async () => {
    const pdf = await rejection({
      name: "truncated.pdf",
      bytes: strToU8("%PDF-1.4 and then nothing useful at all"),
    });
    expect(pdf.status).toBe(400);
    expect(pdf.message).toContain("truncated.pdf");

    const docx = await rejection({
      name: "renamed.docx",
      bytes: strToU8("this was a .doc that someone renamed"),
    });
    expect(docx.status).toBe(400);
    expect(docx.message).toContain("renamed.docx");
  });

  it("rejects a zip that is not a Word document", async () => {
    const error = await rejection({
      name: "photos.docx",
      bytes: zipSync({ "holiday.jpg": strToU8("not xml") }),
    });

    expect(error.message).toContain("word/document.xml");
  });
});
