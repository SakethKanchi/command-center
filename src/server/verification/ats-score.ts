/**
 * Deterministic ATS-compliance score for a generated resume (0-100).
 *
 * Ported from career-ops' `verify-ats.mjs`. The weights, thresholds and scoring
 * semantics are the upstream ones:
 *
 *   text 15 | sections 20 | contact 15 | layout 20
 *   images 10 | fonts 10 | charset 5 | hidden 5        (= 100)
 *
 * What changed in the port: upstream reads a CV *HTML* document, so it can see
 * `<table>`, `column-count`, `font-family` and `<meta charset>` directly. Here
 * the artefact under test is a rendered PDF, so each HTML signal is replaced by
 * the equivalent signal an ATS text extractor actually sees. The mapping is
 * documented at each dimension.
 *
 * No LLM, no network, no writes. The same input always produces the same report.
 */

import { readFile } from "node:fs/promises";
import { badRequest } from "@server/infra/errors";
import { extractPdfText } from "./pdf-text";

// ── Contract ─────────────────────────────────────────────────────────

/** Upstream weights. Kept explicit and summing to 100 so the score is auditable. */
export const ATS_WEIGHTS = {
  text: 15, // real, selectable text present (not a scan / rasterized export)
  sections: 20, // standard, recognizable section headings
  contact: 15, // email (+ phone) reachable in the body
  layout: 20, // single-column flow, no table/grid reading-order scrambling
  images: 10, // no CV text baked into images
  fonts: 10, // standard, embeddable fonts
  charset: 5, // text survives extraction as clean Unicode
  hidden: 5, // no invisible text / keyword stuffing
} as const;

export type AtsDimension = keyof typeof ATS_WEIGHTS;

export interface AtsScoreBreakdownEntry {
  dimension: AtsDimension;
  weight: number;
  earned: number;
  findings: string[];
}

export interface AtsScoreReport {
  score: number;
  passed: boolean;
  threshold: number;
  breakdown: AtsScoreBreakdownEntry[];
}

export interface AtsScoreInput {
  /** Text an ATS extractor would recover, newlines preserved where available. */
  text: string;
  /** Rendered page count; must be >= 1. */
  pageCount: number;
  /** Font names as embedded in the PDF, e.g. `ABCDEF+Arial-BoldMT`. */
  fontNames?: string[];
  /** Number of raster/vector images painted on the pages. */
  imageCount?: number;
  /** Characters drawn invisibly (render mode 3/7, or white-on-white). */
  hiddenTextCharCount?: number;
  /** Pass mark; defaults to the upstream exit gate. */
  threshold?: number;
}

/** Upstream's `--min-score` default and exit gate. */
export const DEFAULT_ATS_THRESHOLD = 70;

// ── Upstream constants ───────────────────────────────────────────────

const TEXT_MIN_CHARS = 300; // below this, the CV likely has no real text layer
const TEXT_LOW_WITH_IMG = 800; // images + this little text => text baked in
/** PDF-native addition: a multi-page CV this thin has a dead page. */
const TEXT_MIN_CHARS_PER_PAGE = 300;
const TEXT_THIN_PAGE_PENALTY = 7;

/**
 * Fonts ATS PDF text extractors handle reliably (widely available and
 * embeddable). Lowercased. Anything outside this table and the generic families
 * below is flagged — not because it always fails, but because it is a risk
 * worth surfacing. Includes the CJK/Arabic fallbacks a multilingual CV needs,
 * so a truthful non-Latin CV is never penalised.
 */
const ATS_SAFE_FONTS: Record<string, true> = {
  arial: true,
  helvetica: true,
  "helvetica neue": true,
  "liberation sans": true,
  "dejavu sans": true,
  calibri: true,
  candara: true,
  corbel: true,
  "segoe ui": true,
  tahoma: true,
  verdana: true,
  "trebuchet ms": true,
  "times new roman": true,
  // Metric clone of Times New Roman, and what the serif template renders with;
  // Liberation Sans above is listed for the same reason.
  "liberation serif": true,
  times: true,
  georgia: true,
  cambria: true,
  garamond: true,
  "book antiqua": true,
  palatino: true,
  "palatino linotype": true,
  lato: true,
  roboto: true,
  "open sans": true,
  "noto sans": true,
  "source sans pro": true,
  "pt sans": true,
  // CJK / Arabic fallbacks.
  "hiragino sans": true,
  "hiragino kaku gothic pron": true,
  "yu gothic": true,
  yugothic: true,
  "noto sans cjk jp": true,
  "noto sans jp": true,
  meiryo: true,
  "ms pgothic": true,
  "pingfang sc": true,
  "hiragino sans gb": true,
  "microsoft yahei": true,
  "noto sans cjk sc": true,
  "noto sans sc": true,
  "source han sans sc": true,
};

/** Generic CSS families — always valid, never "non-standard", so skipped. */
const GENERIC_FAMILIES: Record<string, true> = {
  "sans-serif": true,
  serif: true,
  monospace: true,
  cursive: true,
  fantasy: true,
  "system-ui": true,
  "ui-sans-serif": true,
  "ui-serif": true,
  "ui-monospace": true,
  "ui-rounded": true,
  math: true,
  emoji: true,
  "-apple-system": true,
  blinkmacsystemfont: true,
  inherit: true,
  initial: true,
  unset: true,
};

/**
 * Style tokens dropped from the tail of a font name. `roman` and `book` are
 * deliberately absent: they are load-bearing in "Times New Roman" and
 * "Book Antiqua", both of which are ATS-safe families.
 */
const FONT_STYLE_TOKENS: Record<string, true> = {
  bold: true,
  italic: true,
  oblique: true,
  regular: true,
  medium: true,
  light: true,
  semibold: true,
  demibold: true,
  bolditalic: true,
  boldoblique: true,
  heavy: true,
  thin: true,
  black: true,
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/**
 * A run of phone-shaped characters. The length is bounded ({6,23} inner), so
 * the pattern is ReDoS-safe; the >= 9-digit rule that separates a real number
 * from a CV date range like "2019 - 2024" (8 digits) is counted afterwards.
 */
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{6,23}\d/g;
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_CANDIDATES = 50; // bound the work on adversarial digit-heavy input

// ── Text helpers ─────────────────────────────────────────────────────

/**
 * Whether `text` contains something that looks like a real phone number: a
 * bounded phone-shaped run carrying at least PHONE_MIN_DIGITS digits. Only the
 * first PHONE_MAX_CANDIDATES runs are inspected, so pathological digit-heavy
 * input cannot blow up. Short spans such as "2019 - 2024" (8 digits) are
 * rejected.
 */
export function hasPhoneNumber(text: string): boolean {
  const candidates = text.match(PHONE_CANDIDATE_RE);
  if (!candidates) return false;
  for (const candidate of candidates.slice(0, PHONE_MAX_CANDIDATES)) {
    if ((candidate.match(/\d/g) ?? []).length >= PHONE_MIN_DIGITS) return true;
  }
  return false;
}

/**
 * Lines that plausibly are section headings.
 *
 * Upstream reads `.section-title` divs and `<h1>`-`<h6>`. A PDF has no such
 * markup, so a heading is recognised by shape: a short, standalone,
 * unpunctuated line that is not a list item. Markdown `#` prefixes are accepted
 * so the same function works on a generated Markdown draft.
 */
export function extractHeadingCandidates(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    // A list item is body copy, never a heading: "- Led the Experience team"
    // must not earn the Experience section its 5 points.
    if (/^(?:[-*•·+]|\d+[.)])\s/.test(trimmed)) continue;
    const line = trimmed
      .replace(/^#{1,6}\s*/, "")
      .replace(/[:#*_]+$/, "")
      .trim();
    if (line.length < 2 || line.length > 64) continue;
    if (/[.!?,;]$/.test(line)) continue; // a sentence, not a heading
    if (line.split(/\s+/).length > 6) continue;
    out.push(line.toLowerCase());
  }
  return out;
}

/**
 * Reduce a PDF font name to a comparable family: strip the subset tag, the
 * Monotype packaging suffixes, and the style half.
 *
 *   "ABCDEF+Arial-BoldMT" -> "arial"
 *   "TimesNewRomanPSMT"   -> "times new roman"
 *   "ComicSansMS"         -> "comic sans ms"
 */
export function normalizeFontName(name: string): string {
  const spaced = name
    .trim()
    .replace(/^[A-Z]{6}\+/, "") // PDF subset tag
    .replace(/\.(?:ttf|otf|pfb|woff2?)$/i, "")
    .replace(/(?:PS)?MT$/, "")
    .replace(/PS$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // LiberationSans -> Liberation Sans
    .replace(/['"]/g, "");
  const tokens = spaced
    .split(/[-,_\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last === undefined || FONT_STYLE_TOKENS[last] !== true) break;
    tokens.pop();
  }
  return tokens.join(" ");
}

// ── Dimension scorers ────────────────────────────────────────────────

interface DimensionResult {
  earned: number;
  findings: string[];
}

/** Shared by every dimension the missing text layer takes down with it. */
function noTextLayer(what: string): string {
  return `No text layer to read, so ${what} could not be verified. Export the CV as a text-bearing PDF — not a scan, not an image export — before anything else.`;
}

function scoreTextLayer(compact: string, pageCount: number): DimensionResult {
  const findings: string[] = [];
  if (compact.length < TEXT_MIN_CHARS) {
    findings.push(
      `Only ${compact.length} characters of selectable text across ${pageCount} page(s), expected at least ${TEXT_MIN_CHARS}. The document has no usable text layer — it is a scan or a rasterized export, and an ATS parser reads nothing at all.`,
    );
    return { earned: 0, findings };
  }
  let earned = ATS_WEIGHTS.text;
  if (pageCount > 1 && compact.length / pageCount < TEXT_MIN_CHARS_PER_PAGE) {
    earned -= TEXT_THIN_PAGE_PENALTY;
    findings.push(
      `${compact.length} characters spread over ${pageCount} pages (${Math.round(compact.length / pageCount)} per page). At least one page carries no extractable text — check for a page rendered as an image.`,
    );
  }
  return { earned, findings };
}

const REQUIRED_SECTIONS: Array<{ name: string; re: RegExp }> = [
  { name: "Experience", re: /experience|work history|employment/ },
  { name: "Education", re: /education|academic/ },
  { name: "Skills", re: /skills|competenc|proficienc/ },
];

const BONUS_SECTIONS: Array<{ name: string; re: RegExp }> = [
  { name: "Summary/Profile", re: /summary|profile|objective/ },
  { name: "Projects", re: /projects/ },
  { name: "Certifications", re: /certificat|licenses/ },
];

function scoreSections(text: string): DimensionResult {
  const headings = extractHeadingCandidates(text);
  // A CV whose extractor dropped every newline has no line structure to key
  // off. Matching the whole document is the lenient fallback — this dimension
  // asks whether the sections exist, not where they sit on the page.
  const blob = (
    headings.length > 0
      ? headings.join(" | ")
      : text.replace(/\s+/g, " ").trim()
  ).toLowerCase();

  const findings: string[] = [];
  let earned = 0;
  for (const section of REQUIRED_SECTIONS) {
    if (section.re.test(blob)) {
      earned += 5;
      continue;
    }
    findings.push(
      `No "${section.name}" heading found (-5). ATS parsers slot content by recognizable headings; anything under an unrecognized heading is often dropped entirely.`,
    );
  }

  const bonusFound = BONUS_SECTIONS.filter((section) => section.re.test(blob));
  const bonusEarned = Math.min(5, bonusFound.length * 2);
  earned += bonusEarned;
  if (bonusEarned < 5) {
    const missing = BONUS_SECTIONS.filter(
      (section) => !section.re.test(blob),
    ).map((section) => section.name);
    findings.push(
      `Only ${bonusFound.length} of 3 supporting sections present (-${5 - bonusEarned}). Add ${missing.join(", ")} to fill out the profile an ATS indexes.`,
    );
  }
  return { earned, findings };
}

function scoreContact(text: string): DimensionResult {
  const findings: string[] = [];
  let earned = 0;
  if (EMAIL_RE.test(text)) {
    earned += 10;
  } else {
    findings.push(
      "No parseable email address in the extracted text (-10). ATS intake and recruiters both key off a plain-text contact email; an address that exists only inside a logo or a header image is unreachable.",
    );
  }
  if (hasPhoneNumber(text)) {
    earned += 5;
  } else {
    findings.push(
      "No phone number detected (-5). Many ATS intake forms auto-populate from one, and a missing number becomes a manual-entry field the recruiter has to fill.",
    );
  }
  return { earned, findings };
}

/**
 * Layout. Upstream inspects the markup (`<table>`, `column-count`,
 * `position:absolute`); here the same three failures are read off the shape of
 * the extracted text, which is exactly what scrambles an ATS reading order:
 *
 *   -12  three-or-more-cell lines         (table / grid layout)
 *   -8   two substantial columns per line (multi-column body)
 *   -4   text recovered in fragments      (reading order already broken)
 */
function scoreLayout(text: string): DimensionResult {
  const findings: string[] = [];
  let earned = ATS_WEIGHTS.layout;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);

  let tableLines = 0;
  let columnLines = 0;
  let totalChars = 0;
  for (const line of lines) {
    totalChars += line.trim().length;
    const tabs = (line.match(/\t/g) ?? []).length;
    // A wide run of whitespace is where a column break landed once the page was
    // flattened to text.
    const cells = line
      .split(/[ \t]{3,}/)
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length >= 3 || tabs >= 2) {
      tableLines += 1;
      continue;
    }
    // Two cells that are BOTH substantial is a second column of prose. A
    // right-aligned date ("Acme Corp        2020-2024") leaves a wide gap too,
    // so a short right-hand cell is deliberately not counted.
    const left = cells[0];
    const right = cells[1];
    if (
      cells.length === 2 &&
      left !== undefined &&
      right !== undefined &&
      left.length >= 15 &&
      right.length >= 20
    ) {
      columnLines += 1;
    }
  }

  if (tableLines >= 2) {
    earned -= 12;
    findings.push(
      `${tableLines} extracted line(s) split into three or more columns (-12). Table and grid layouts scramble the order an ATS reads cells in; use a single-column flow.`,
    );
  }
  if (
    lines.length > 0 &&
    columnLines >= 3 &&
    columnLines / lines.length >= 0.15
  ) {
    earned -= 8;
    findings.push(
      `${columnLines} of ${lines.length} extracted lines carry two side-by-side text columns (-8). A sidebar layout interleaves unrelated sentences once flattened; single-column content parses most reliably.`,
    );
  }
  const averageLineLength = lines.length > 0 ? totalChars / lines.length : 0;
  if (lines.length >= 12 && averageLineLength < 15) {
    earned -= 4;
    findings.push(
      `Text came back as ${lines.length} fragments averaging ${Math.round(averageLineLength)} characters (-4). The reading order is already broken at extraction time, which is how absolutely-positioned or boxed layouts fail.`,
    );
  }
  return { earned: Math.max(0, earned), findings };
}

function scoreImages(imageCount: number, textLength: number): DimensionResult {
  if (imageCount > 0 && textLength < TEXT_LOW_WITH_IMG) {
    return {
      earned: 0,
      findings: [
        `${imageCount} image(s) with only ${textLength} characters of surrounding text (-10). The CV's content is baked into the artwork, and image text is invisible to every ATS.`,
      ],
    };
  }
  if (imageCount > 0) {
    return {
      earned: ATS_WEIGHTS.images - 5,
      findings: [
        `${imageCount} image(s) embedded (-5). Verify no skills, headings or contact details live inside them — an ATS cannot read image text.`,
      ],
    };
  }
  return { earned: ATS_WEIGHTS.images, findings: [] };
}

function scoreFonts(fontNames: string[] | undefined): DimensionResult {
  // Nothing measured, nothing to penalise: upstream awards the full weight when
  // it finds no non-standard family.
  if (fontNames === undefined)
    return { earned: ATS_WEIGHTS.fonts, findings: [] };

  const families = new Set<string>();
  for (const raw of fontNames) {
    const family = normalizeFontName(raw);
    if (family && GENERIC_FAMILIES[family] !== true) families.add(family);
  }
  const unsafe = [...families].filter(
    (family) => ATS_SAFE_FONTS[family] !== true,
  );
  if (unsafe.length === 0) return { earned: ATS_WEIGHTS.fonts, findings: [] };
  return {
    earned: Math.max(0, ATS_WEIGHTS.fonts - unsafe.length * 3),
    findings: [
      `Non-standard font(s): ${unsafe.join(", ")} (-${Math.min(ATS_WEIGHTS.fonts, unsafe.length * 3)}). Prefer widely-supported, embeddable faces (Arial, Helvetica, Calibri, Times New Roman, Georgia) so text extraction is lossless.`,
    ],
  };
}

/**
 * Character encoding. Upstream checks for `<meta charset="utf-8">`; the PDF
 * equivalent is whether the glyphs survived extraction as real Unicode instead
 * of replacement characters or mojibake.
 */
function scoreCharacterEncoding(text: string): DimensionResult {
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  // "Ã©" / "Â " — UTF-8 bytes decoded as Latin-1, the classic signature of a
  // broken /ToUnicode map or a non-embedded encoding.
  const mojibake = (text.match(/[ÂÃ][\u0080-\u00BF]/g) ?? []).length;
  // Counted by code point rather than a regex: a character class over the C0
  // range embeds raw control characters in the source, which is both a lint
  // violation and invisible to anyone reading the file. TAB, LF and CR are
  // legitimate layout characters in extracted text and are excluded.
  let controls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isC0 = code <= 0x1f;
    const isLayout = code === 0x09 || code === 0x0a || code === 0x0d;
    if (isC0 && !isLayout) controls += 1;
  }
  const broken = replacements + mojibake + controls;
  if (broken === 0) return { earned: ATS_WEIGHTS.charset, findings: [] };
  return {
    earned: 0,
    findings: [
      `${broken} character(s) did not survive text extraction as Unicode (${replacements} replacement, ${mojibake} mojibake, ${controls} control) (-5). Embed the fonts with a /ToUnicode map so accents and symbols come through intact.`,
    ],
  };
}

function scoreHiddenText(hiddenTextCharCount: number): DimensionResult {
  if (hiddenTextCharCount <= 0) {
    return { earned: ATS_WEIGHTS.hidden, findings: [] };
  }
  return {
    earned: 0,
    findings: [
      `${hiddenTextCharCount} character(s) are drawn invisibly — white-on-white, or text rendering mode 3 (-5). Modern ATS penalise hidden keywords, and the recruiter reading the extracted text sees them as an attempt to game the filter.`,
    ],
  };
}

// ── Public scoring entry point ───────────────────────────────────────

/** Assemble one breakdown row, enforcing `0 <= earned <= weight` in one place. */
function entry(
  dimension: AtsDimension,
  result: DimensionResult,
): AtsScoreBreakdownEntry {
  const weight = ATS_WEIGHTS[dimension];
  return {
    dimension,
    weight,
    earned: Math.min(weight, Math.max(0, Math.round(result.earned))),
    findings: result.findings,
  };
}

export function scoreAtsCompliance(input: AtsScoreInput): AtsScoreReport {
  if (typeof input.text !== "string") {
    throw badRequest("scoreAtsCompliance requires `text` to be a string");
  }
  if (!Number.isInteger(input.pageCount) || input.pageCount < 1) {
    throw badRequest(
      "scoreAtsCompliance requires `pageCount` to be an integer >= 1",
    );
  }
  const threshold = input.threshold ?? DEFAULT_ATS_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw badRequest(
      "scoreAtsCompliance requires `threshold` between 0 and 100",
    );
  }
  const imageCount = input.imageCount ?? 0;
  const hiddenTextCharCount = input.hiddenTextCharCount ?? 0;
  if (!Number.isFinite(imageCount) || imageCount < 0) {
    throw badRequest("scoreAtsCompliance requires `imageCount` to be >= 0");
  }
  if (!Number.isFinite(hiddenTextCharCount) || hiddenTextCharCount < 0) {
    throw badRequest(
      "scoreAtsCompliance requires `hiddenTextCharCount` to be >= 0",
    );
  }

  const compact = input.text.replace(/\s+/g, " ").trim();
  const textResult = scoreTextLayer(compact, input.pageCount);
  // Every dimension below reads the text layer. With no text layer those checks
  // are not "clean", they are unevidenced — and an ATS handed this file sees
  // nothing at all, so the score has to say so instead of quietly awarding the
  // weight of every check that had nothing to fail on.
  const hasTextLayer = compact.length >= TEXT_MIN_CHARS;

  const breakdown: AtsScoreBreakdownEntry[] = [
    entry("text", textResult),
    entry(
      "sections",
      hasTextLayer
        ? scoreSections(input.text)
        : { earned: 0, findings: [noTextLayer("the section headings")] },
    ),
    entry(
      "contact",
      hasTextLayer
        ? scoreContact(input.text)
        : { earned: 0, findings: [noTextLayer("the contact details")] },
    ),
    entry(
      "layout",
      hasTextLayer
        ? scoreLayout(input.text)
        : { earned: 0, findings: [noTextLayer("the reading order")] },
    ),
    entry("images", scoreImages(imageCount, compact.length)),
    entry(
      "fonts",
      hasTextLayer
        ? scoreFonts(input.fontNames)
        : { earned: 0, findings: [noTextLayer("the embedded fonts")] },
    ),
    entry(
      "charset",
      hasTextLayer
        ? scoreCharacterEncoding(input.text)
        : { earned: 0, findings: [noTextLayer("the character encoding")] },
    ),
    entry("hidden", scoreHiddenText(hiddenTextCharCount)),
  ];

  const total = breakdown.reduce((sum, item) => sum + item.earned, 0);
  const score = Math.min(100, Math.max(0, Math.round(total)));
  return { score, passed: score >= threshold, threshold, breakdown };
}

// ── PDF adapter ──────────────────────────────────────────────────────

/** Score a rendered PDF on disk. Throws `PdfTextExtractionError` on a bad file. */
export async function scoreAtsComplianceForPdf(
  pdfPath: string,
  options: { threshold?: number } = {},
): Promise<AtsScoreReport> {
  const buffer = await readFile(pdfPath);
  const inputs = await extractPdfText(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  return scoreAtsCompliance({ ...inputs, threshold: options.threshold });
}
