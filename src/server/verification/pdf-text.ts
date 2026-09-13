/**
 * Read the four signals an ATS text extractor sees out of a PDF, in one parse.
 *
 * The ATS gate scores a rendered artefact, not markup, so it needs what the
 * extractor would get: the reading-order text, the page count, the embedded
 * font families, how many rasters were painted, and how many glyphs were drawn
 * invisibly. Splitting this out keeps `ats-score.ts` a pure function of those
 * numbers, which is what makes the score reproducible from a fixture.
 *
 * pdfjs is loaded lazily and cached: the ATS gate is not on the hot path, and
 * the legacy build pulls in enough that paying for it at import time would slow
 * every unrelated test file in the suite.
 */

import { createRequire } from "node:module";
import path from "node:path";

/**
 * A PDF that could not be parsed at all — truncated, encrypted, or not a PDF.
 * Distinct from a parseable file that scores badly: the gate reports the latter
 * as a score of zero and only ever rethrows this.
 */
export class PdfTextExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTextExtractionError";
  }
}

export interface PdfText {
  text: string;
  pageCount: number;
  fontNames: string[];
  imageCount: number;
  hiddenTextCharCount: number;
}

/**
 * Structural view of the five pdfjs members used here. pdfjs-dist' own
 * declarations drag DOM types into a server module that never touches one, and
 * this keeps a pdfjs major bump from breaking the build of a gate that does not
 * care. Every field is optional because `getTextContent` yields a union of text
 * items and marked-content markers; the reads below narrow at runtime.
 */
interface PdfTextItemLike {
  str?: string;
  width?: number;
  hasEOL?: boolean;
  transform?: number[];
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  commonObjs: { get(name: string): { name?: unknown } | null };
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

interface PdfjsModuleLike {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<PdfDocumentLike>;
  };
  OPS: Record<string, number>;
}

const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintJpegXObject",
  "paintImageMaskXObject",
  "paintImageMaskXObjectRepeat",
  "paintImageMaskXObjectGroup",
] as const;

/** Operator name -> index of its glyph-array argument. */
const SHOW_TEXT_OP_ARG_INDEX: Record<string, number> = {
  showText: 0,
  showSpacedText: 0,
  nextLineShowText: 0,
  nextLineSetSpacingShowText: 2,
};

let cachedPdfjs: Promise<PdfjsModuleLike> | null = null;

function loadPdfjs(): Promise<PdfjsModuleLike> {
  if (cachedPdfjs === null) {
    cachedPdfjs = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      // Unchecked: the module is the library itself, not external data, and
      // PdfjsModuleLike is a deliberate narrow view of it.
      const narrowed = module as unknown as PdfjsModuleLike;
      return narrowed;
    });
  }
  return cachedPdfjs;
}

/** Directory of pdfjs' bundled standard fonts / CMaps, or null when unresolvable. */
function pdfjsAssetRoot(): string | null {
  try {
    const resolve = createRequire(import.meta.url).resolve;
    return path.dirname(resolve("pdfjs-dist/package.json"));
  } catch {
    return null;
  }
}

function isWhiteFill(color: unknown): boolean {
  if (typeof color === "string")
    return /^#?(?:fff|ffffff)$/i.test(color.trim());
  if (Array.isArray(color) && color.length >= 3) {
    return color.slice(0, 3).every((channel) => Number(channel) >= 255);
  }
  return false;
}

/** Printable glyphs in a pdfjs show-text argument (numbers are kerning, not text). */
function countGlyphs(glyphs: unknown): number {
  if (!Array.isArray(glyphs)) return 0;
  let count = 0;
  for (const glyph of glyphs) {
    if (glyph === null || typeof glyph !== "object") continue;
    if (!("unicode" in glyph)) continue;
    const unicode = glyph.unicode;
    if (typeof unicode === "string" && unicode.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Rebuild the page text the way an extractor sees it, inserting a wide gap
 * where the glyphs jump horizontally. Without that, every layout flattens to
 * innocent-looking prose and the layout dimension has nothing to read.
 */
function appendPageText(items: PdfTextItemLike[], lines: string[]): void {
  let line = "";
  let previousEndX: number | null = null;
  let previousFontSize = 10;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const transform = Array.isArray(item.transform) ? item.transform : null;
    const x = transform ? Number(transform[4]) : Number.NaN;
    const fontSize = transform
      ? Math.abs(Number(transform[3])) || Math.abs(Number(transform[0]))
      : 0;
    if (
      previousEndX !== null &&
      Number.isFinite(x) &&
      x - previousEndX > Math.max(6, previousFontSize * 1.2)
    ) {
      line += "   ";
    }
    line += item.str;
    if (Number.isFinite(x)) {
      const width = Number(item.width);
      previousEndX = x + (Number.isFinite(width) ? width : 0);
    }
    if (Number.isFinite(fontSize) && fontSize > 0) previousFontSize = fontSize;
    if (item.hasEOL === true) {
      lines.push(line);
      line = "";
      previousEndX = null;
    }
  }
  if (line.length > 0) lines.push(line);
}

/** Everything the ATS score needs, read out of a PDF in a single parse. */
export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  const pdfjs = await loadPdfjs();
  const assetRoot = pdfjsAssetRoot();
  const imageOps = new Set<number>();
  for (const name of IMAGE_OP_NAMES) {
    const op = pdfjs.OPS[name];
    if (typeof op === "number") imageOps.add(op);
  }
  const showTextOps = new Map<number, number>();
  for (const [name, argIndex] of Object.entries(SHOW_TEXT_OP_ARG_INDEX)) {
    const op = pdfjs.OPS[name];
    if (typeof op === "number") showTextOps.set(op, argIndex);
  }

  let pdfDocument: PdfDocumentLike;
  try {
    pdfDocument = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
      ...(assetRoot === null
        ? {}
        : {
            standardFontDataUrl: `${path.join(assetRoot, "standard_fonts")}${path.sep}`,
            cMapUrl: `${path.join(assetRoot, "cmaps")}${path.sep}`,
            cMapPacked: true,
          }),
    }).promise;
  } catch {
    throw new PdfTextExtractionError(
      "PDF file could not be read or is encrypted.",
    );
  }

  try {
    const lines: string[] = [];
    const fontNames = new Set<string>();
    let imageCount = 0;
    let hiddenTextCharCount = 0;

    for (
      let pageNumber = 1;
      pageNumber <= pdfDocument.numPages;
      pageNumber += 1
    ) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      appendPageText(textContent.items, lines);

      const operators = await page.getOperatorList();
      let renderMode = 0;
      let fillColor: unknown = null;
      const stack: Array<{ renderMode: number; fillColor: unknown }> = [];
      for (let i = 0; i < operators.fnArray.length; i += 1) {
        const op = operators.fnArray[i];
        if (op === undefined) continue;
        const args = operators.argsArray[i] ?? [];
        if (op === pdfjs.OPS.save) {
          stack.push({ renderMode, fillColor });
          continue;
        }
        if (op === pdfjs.OPS.restore) {
          const previous = stack.pop();
          if (previous !== undefined) {
            renderMode = previous.renderMode;
            fillColor = previous.fillColor;
          }
          continue;
        }
        if (op === pdfjs.OPS.setTextRenderingMode) {
          renderMode = Number(args[0]) || 0;
          continue;
        }
        if (op === pdfjs.OPS.setFillRGBColor) {
          fillColor = args.length > 1 ? args : args[0];
          continue;
        }
        if (op === pdfjs.OPS.setFont) {
          const loadedName = args[0];
          if (typeof loadedName === "string") {
            try {
              const name = page.commonObjs.get(loadedName)?.name;
              if (typeof name === "string" && name.length > 0)
                fontNames.add(name);
            } catch {
              // Font object not resolved for this page; nothing to report.
            }
          }
          continue;
        }
        if (imageOps.has(op)) {
          imageCount += 1;
          continue;
        }
        const glyphArgIndex = showTextOps.get(op);
        if (glyphArgIndex === undefined) continue;
        // Modes 3 and 7 paint nothing; modes 0/2/4/6 paint the fill colour, so
        // white-on-white is the other half of the classic stuffing trick.
        const invisible =
          renderMode === 3 ||
          renderMode === 7 ||
          ((renderMode === 0 ||
            renderMode === 2 ||
            renderMode === 4 ||
            renderMode === 6) &&
            isWhiteFill(fillColor));
        if (invisible) hiddenTextCharCount += countGlyphs(args[glyphArgIndex]);
      }
    }

    return {
      text: lines.join("\n"),
      pageCount: pdfDocument.numPages,
      fontNames: [...fontNames],
      imageCount,
      hiddenTextCharCount,
    };
  } finally {
    await pdfDocument.destroy();
  }
}
