/**
 * Fabrication gate for generated candidate-facing documents.
 *
 * Ported from career-ops' `verify-cv-facts.mjs`. Every numeric claim the
 * generated document makes — percentages, money, multipliers, counts of a
 * metric noun, employment year spans — must be evidenced by the source of
 * truth. A claim the sources do not contain is a number the agent invented.
 *
 * What changed in the port: upstream reads `cv.md` / `article-digest.md` off
 * disk and carries a config file with allow-lists and non-metric (employer /
 * title / tool) claims. Here the sources arrive as strings and the report is
 * the three-kind violation list the command centre renders. The extraction
 * rules, the normalization and the false-positive guards are upstream's.
 *
 * No LLM, no network, no file reads. The same input always produces the same
 * report.
 */

// ── Contract ─────────────────────────────────────────────────────────

export type FactGateViolationKind =
  | "unsupported_number"
  | "unsupported_metric"
  | "forbidden_phrase";

export interface FactGateViolation {
  kind: FactGateViolationKind;
  /** The normalized claim, or the phrase that was banned. */
  claim: string;
  /** Surrounding document text, so a human can judge the call. */
  context: string;
}

export interface FactGateReport {
  passed: boolean;
  violations: FactGateViolation[];
  /** Distinct numeric/metric claims extracted from the generated document. */
  checkedClaims: number;
}

export interface FactGateInput {
  /** The generated document: HTML, Markdown, LaTeX or plain text. */
  generated: string;
  /** Source-of-truth documents. Concatenated before checking. */
  sources: string[];
  /** Overrides `DEFAULT_FORBIDDEN_PHRASES` when supplied. */
  forbiddenPhrases?: string[];
}

/**
 * Upstream's cliché fallback list (career-ops `modes/_writing.md`), the set a
 * CV generator reaches for when it has nothing concrete to say. Matched as
 * case-insensitive substrings, exactly as upstream does.
 */
export const DEFAULT_FORBIDDEN_PHRASES: string[] = [
  "passionate about",
  "results-oriented",
  "proven track record",
  "leveraged",
  "spearheaded",
  "facilitated",
  "synergies",
  "seamless",
  "cutting-edge",
  "in today's fast-paced world",
  "demonstrated ability to",
  "best practices",
];

// ── Extraction vocabulary ────────────────────────────────────────────

const METRIC_NOUNS = [
  "users",
  "customers",
  "clients",
  "employees",
  "engineers",
  "teams",
  "companies",
  "partners",
  "organizations",
  "organisations",
  "brands",
  "countries",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
  "minutes",
  "seconds",
  "requests",
  "tokens",
  "documents",
  "workflows",
  "pipelines",
  "agents",
  "interviews",
  "applications",
  "offers",
  "reports",
  "cvs",
  "resumes",
  "enrollments",
  "enrolments",
  "completions",
  "courses",
  "certifications",
  "certificates",
  "sessions",
  "responses",
  "surveys",
  "cohorts",
  "commits",
  "contributions",
  "repositories",
  "repos",
  "modules",
  "tools",
  "servers",
  "guides",
  "articles",
  "datasets",
  "examples",
  "deployments",
  "services",
  "downloads",
  "stars",
  "lines",
  "projects",
  "integrations",
  "tests",
  // Headcount outside software. Without these a CV in operations, facilities,
  // healthcare, education or the trades produced NO claim for the one number
  // those CVs actually inflate: how many people were managed.
  "staff",
  "personnel",
  "people",
  "technicians",
  "operators",
  "contractors",
  "vendors",
  "scientists",
  "researchers",
  "volunteers",
  "students",
  "patients",
  "crew",
  // Physical assets and scale, for the same reason.
  "facilities",
  "sites",
  "buildings",
  "rooms",
  "labs",
  "laboratories",
  "plants",
  "machines",
  "devices",
  "instruments",
  "vehicles",
  "units",
  "locations",
  "acres",
  "hectares",
  "shifts",
  "rounds",
  "inspections",
  "audits",
  "incidents",
  "alarms",
  "tickets",
];

/**
 * How many words may sit between a number and the noun it counts. The same
 * regex parses the generated document and the sources, so the window is
 * symmetric — but a window still decides WHETHER a claim exists, and the two
 * sides rarely word a fact identically. At 2, "~5 live Cloud Run deployments"
 * (three modifiers) yielded no claim while the paraphrase "~5 Cloud Run
 * deployments" (two) did, which broke the gate in both directions: a truthful
 * CV failed, and a CHANGED number passed because the generated side produced
 * no claim to compare. Widening only ever extracts MORE claims, on both sides,
 * and a number is a hard barrier for the chain (modifiers are alphabetic), so
 * it cannot jump an intervening figure to bind an unrelated noun.
 */
const MODIFIER_WINDOW = 4;

/**
 * A number counting a metric noun. The number capture takes an immediately
 * adjacent magnitude suffix (50k, 1.5M) as part of the number: without it the
 * modifier window re-consumed that letter as a word, so "50k users" normalized
 * to "50 users" and matched a source saying 50 — a 1000x inflation through the
 * gate. `[kKmMbB]\b` requires the suffix to END the token, so "50 million
 * users" and "50kg users" keep their previous behaviour.
 */
const COUNT_CLAIM_RE = new RegExp(
  String.raw`\b(\d[\d,.]*(?:[kKmMbB]\b)?)\s*\+?\s*(?:[A-Za-z][A-Za-z-]*\s+){0,${MODIFIER_WINDOW}}(${METRIC_NOUNS.join("|")})\b`,
  "gi",
);

/** A paraphrase is not a fabrication: "20 personnel" restates "20 staff". */
const NOUN_SYNONYMS: Record<string, string> = {
  repos: "repositories",
  enrolments: "enrollments",
  organisations: "organizations",
  cvs: "resumes",
  certificates: "certifications",
  articles: "guides",
  personnel: "staff",
  labs: "laboratories",
};

/** Language-neutral claims: percentages, money, multipliers. */
const SIMPLE_CLAIM_PATTERNS = [
  /\b\d+(?:\.\d+)?\s?%/g,
  /(?<![\w$€£])[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB])?/g,
  /\b\d+(?:\.\d+)?\s?x\b/gi,
];

/**
 * An employment / education span. A BARE year is never a claim (see the year
 * guard below); a span is, because shifting one end is how a generated CV
 * silently stretches a tenure.
 */
const YEAR_SPAN_RE =
  /\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|current|now)\b/gi;
const YEAR_SPAN_CLAIM_RE =
  /^(?:19|20)\d{2}-(?:(?:19|20)\d{2}|present|current|now)$/;
const OPEN_ENDED_SPAN: Record<string, true> = {
  present: true,
  current: true,
  now: true,
};
const YEAR_TOKEN_RE = /\b(?:19|20)\d{2}\b/g;
/** A year is not a count. "Led the 2024 migration" has the shape and none of
 *  the meaning, and every CV has several. */
const YEAR_LIKE = /^(?:19|20)\d{2}$/;

// ── False-positive guards ────────────────────────────────────────────

/**
 * GUARD (URLs): digits inside a link are addresses, not achievements —
 * `github.com/acme/repo/pull/1200`, `/v2/`, `?page=30`.
 */
const URL_RE =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi;

/** GUARD (page numbers): "Page 2 of 3" running heads from a paginated export. */
const PAGE_LABEL_RE = /\bpages?\s+\d+(?:\s*(?:of|\/|-|–)\s*\d+)?/gi;

/** GUARD (page numbers): a line that is nothing but a short number. */
const STANDALONE_NUMBER_LINE_RE = /^[ \t]*\d{1,3}[ \t]*$/gm;

/**
 * GUARD (phones): a phone-shaped run. Bounded length keeps it ReDoS-safe; the
 * >= 9-digit rule separates a real number from a date range like "2019 - 2024"
 * (8 digits), and requiring a non-period separator keeps a period-grouped
 * figure ("123.456.789 requests") out of the mask.
 */
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{6,23}\d/g;
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_DIGITS = 15; // E.164 ceiling

const CONTEXT_RADIUS = 60;

// ── Normalization (ported verbatim) ──────────────────────────────────

/**
 * Unicode decimal-digit blocks, by the code point of their zero. Every claim
 * pattern here is written with ASCII `\d`, so a document that spells its
 * numbers in another script produced ZERO claims and the gate reported a pass
 * without having checked anything. NFKC alone is not enough: it folds
 * full-width digits but leaves Arabic-Indic, Persian and Devanagari untouched.
 */
const DIGIT_ZEROS = [
  0x0660, // Arabic-Indic (ar)
  0x06f0, // Extended Arabic-Indic (fa, ur)
  0x0966, // Devanagari (hi)
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x17e0, // Khmer
  0x1810, // Mongolian
];

/**
 * Rewrite every Unicode decimal digit as its ASCII counterpart, plus the
 * separators and percent signs that travel with them, so the claim patterns
 * see the same numbers whatever script wrote them. Applied to the generated
 * document AND to the sources, so it can only ever make MORE claims visible on
 * both sides — it cannot hide one.
 */
export function foldDigits(text: string): string {
  let out = text.normalize("NFKC");
  out = out.replace(/\p{Nd}/gu, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x30 && codePoint <= 0x39) return char;
    for (const zero of DIGIT_ZEROS) {
      const value = codePoint - zero;
      if (value >= 0 && value <= 9) return String(value);
    }
    return char; // a decimal digit from a block we do not list
  });
  out = out
    .replace(/\u066a/g, "%") // Arabic percent sign
    .replace(/\u066b/g, ".") // Arabic decimal separator
    .replace(/\u066c/g, ","); // Arabic thousands separator
  // A SPACE-grouped thousand ("16 181", common in fr/ru/sv and as NNBSP in
  // typeset text) has to be joined before extraction: the claim pattern reads a
  // number as `\d[\d,.]*`, so it would stop at the space and extract "181
  // users" — a claim the sources never contain, failing a truthful CV. The
  // `(?<!\d)\d{1,3}` guard keeps it to real grouping: in "in 2026 100 users"
  // the left part is four digits, so nothing is joined.
  return out.replace(/(?<!\d)(\d{1,3})[\s\u00a0\u202f](?=\d{3}(?!\d))/g, "$1");
}

/** Remove HTML, basic LaTeX commands, and excess whitespace from document text. */
export function stripMarkup(text: string): string {
  return (
    foldDigits(text)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      // A BLOCK boundary becomes a sentence break, not a space: collapsing
      // `</li><li>` to ' ' glues two bullets into one line and lets captures
      // chain across them.
      .replace(
        /<\/?(?:li|p|div|tr|h[1-6]|section|article|ul|ol|table|br)\b[^>\n]*>/gi,
        ". ",
      )
      // Only strip things that actually look like tags. A bare `<` is ordinary
      // prose in these documents (`p<0.001`, `<30 min`), and `[^>]` matches
      // newlines — so a looser pattern lets one stray `<` swallow everything up
      // to the next `>`, deleting real evidence and failing a truthful CV.
      .replace(/<\/?[a-zA-Z][^>\n]*>/g, " ")
      .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, " $1 ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Normalize a claim for case- and grouping-insensitive comparison.
 *
 * Thousands separators are removed FIRST, so the same number compares equal
 * however it is grouped: "16,181" / "16 181" / "16181" / "16.181". Only a
 * separator followed by EXACTLY three digits is removed, so an ordinary
 * decimal ("2.5 hours") survives. The period is in the class for the same
 * reason the comma is, from the other side of the convention: grouping style
 * is not evidence of a different number, and the gate used to report one as
 * invented.
 *
 * The trailing `\s+` fold before a unit letter is the one addition to
 * upstream's rule: it only ever makes two spellings of the SAME figure compare
 * equal ("60 %" / "60%", "$1.2 M" / "$1.2M"), so it can never hide a number
 * the sources do not contain.
 */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/(\d)[,.\s\u00a0\u202f](?=\d{3}(?!\d))/g, "$1")
    .replace(/[,\s]+/g, " ")
    .replace(/(\d)\s+(?=[kmb%x]\b)/g, "$1")
    .trim();
}

// ── Masking ──────────────────────────────────────────────────────────

/**
 * Blank the given half-open ranges. Length-preserving on purpose: every claim
 * index is taken from the masked text and used to quote the UNMASKED text, so
 * the two must stay aligned character for character.
 */
function maskRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i += 1) chars[i] = " ";
  }
  return chars.join("");
}

/** Apply the URL / page-number / phone guards to already-cleaned text. */
function maskNonClaims(clean: string): string {
  const ranges: Array<[number, number]> = [];
  URL_RE.lastIndex = 0;
  for (const match of clean.matchAll(URL_RE)) {
    if (match.index === undefined) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  PAGE_LABEL_RE.lastIndex = 0;
  for (const match of clean.matchAll(PAGE_LABEL_RE)) {
    if (match.index === undefined) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  const masked = maskRanges(clean, ranges);

  // Money, percentages and multipliers are real claims that can look like a
  // digit run, so they are protected before the phone guard runs.
  const protectedRanges: Array<[number, number]> = [];
  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      if (match.index === undefined) continue;
      protectedRanges.push([match.index, match.index + match[0].length]);
    }
  }

  const phoneRanges: Array<[number, number]> = [];
  PHONE_CANDIDATE_RE.lastIndex = 0;
  for (const match of masked.matchAll(PHONE_CANDIDATE_RE)) {
    if (match.index === undefined) continue;
    const candidate = match[0];
    const digits = (candidate.match(/\d/g) ?? []).length;
    if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) continue;
    // Period-only grouping is a number ("123.456.789 requests"), not a phone.
    if (!/[+()\s-]/.test(candidate)) continue;
    const start = match.index;
    const end = start + candidate.length;
    const overlaps = protectedRanges.some(
      ([from, to]) => start < to && end > from,
    );
    if (overlaps) continue;
    phoneRanges.push([start, end]);
  }
  return maskRanges(masked, phoneRanges);
}

// ── Claim extraction ─────────────────────────────────────────────────

interface ExtractedClaim {
  kind: "unsupported_number" | "unsupported_metric";
  claim: string;
  index: number;
}

function extractClaims(clean: string): ExtractedClaim[] {
  const masked = maskNonClaims(clean);
  const found: ExtractedClaim[] = [];

  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      if (match.index === undefined) continue;
      found.push({
        kind: "unsupported_number",
        claim: normalizeClaim(match[0]),
        index: match.index,
      });
    }
  }

  YEAR_SPAN_RE.lastIndex = 0;
  for (const match of masked.matchAll(YEAR_SPAN_RE)) {
    if (match.index === undefined) continue;
    found.push({
      kind: "unsupported_number",
      claim: match[0].toLowerCase().replace(/\s*[-–—]\s*/, "-"),
      index: match.index,
    });
  }

  COUNT_CLAIM_RE.lastIndex = 0;
  for (const match of masked.matchAll(COUNT_CLAIM_RE)) {
    const rawNumber = match[1];
    const rawNoun = match[2];
    if (match.index === undefined || rawNumber === undefined) continue;
    if (rawNoun === undefined) continue;
    // GUARD (years): "in 2019 projects" is a date, not a headcount.
    if (YEAR_LIKE.test(rawNumber.replace(/[,.]/g, ""))) continue;
    const noun = rawNoun.toLowerCase();
    found.push({
      kind: "unsupported_metric",
      claim: normalizeClaim(`${rawNumber} ${NOUN_SYNONYMS[noun] ?? noun}`),
      index: match.index,
    });
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const unique: ExtractedClaim[] = [];
  for (const claim of found) {
    const key = `${claim.kind}:${claim.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(claim);
  }
  return unique;
}

// ── Gate ─────────────────────────────────────────────────────────────

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function verifyDocumentFacts(input: FactGateInput): FactGateReport {
  const generated = typeof input.generated === "string" ? input.generated : "";
  const cleanGenerated = stripMarkup(
    // GUARD (page numbers): done before the whitespace collapse, which is the
    // only point where a line is still a line.
    generated.replace(STANDALONE_NUMBER_LINE_RE, (line) =>
      " ".repeat(line.length),
    ),
  );
  const cleanSources = stripMarkup((input.sources ?? []).join("\n"));

  const supported = new Set<string>();
  for (const claim of extractClaims(cleanSources)) supported.add(claim.claim);
  const sourceYears = new Set<string>(cleanSources.match(YEAR_TOKEN_RE) ?? []);

  const claims = extractClaims(cleanGenerated);
  const scored: Array<FactGateViolation & { index: number }> = [];

  for (const claim of claims) {
    if (supported.has(claim.claim)) continue;
    // A span is evidenced when BOTH endpoints appear in the sources: the
    // sources phrase a tenure a dozen ways ("2020 to 2024", a bullet per role),
    // so demanding the exact span string back would fail truthful documents,
    // while moving either end still has to invent a year.
    if (YEAR_SPAN_CLAIM_RE.test(claim.claim)) {
      const [from, to] = claim.claim.split("-");
      if (
        from !== undefined &&
        to !== undefined &&
        sourceYears.has(from) &&
        (OPEN_ENDED_SPAN[to] === true || sourceYears.has(to))
      ) {
        continue;
      }
    }
    scored.push({
      kind: claim.kind,
      claim: claim.claim,
      context: contextAround(cleanGenerated, claim.index, claim.claim.length),
      index: claim.index,
    });
  }

  const phrases = input.forbiddenPhrases ?? DEFAULT_FORBIDDEN_PHRASES;
  const lowerGenerated = cleanGenerated.toLowerCase();
  for (const phrase of phrases) {
    if (!phrase) continue;
    const needle = phrase.toLowerCase();
    const index = lowerGenerated.indexOf(needle);
    if (index === -1) continue;
    scored.push({
      kind: "forbidden_phrase",
      claim: phrase,
      context: contextAround(cleanGenerated, index, needle.length),
      index,
    });
  }

  scored.sort((a, b) => a.index - b.index);
  const violations: FactGateViolation[] = scored.map(
    ({ kind, claim, context }) => ({
      kind,
      claim,
      context,
    }),
  );

  return {
    passed: violations.length === 0,
    violations,
    checkedClaims: claims.length,
  };
}
