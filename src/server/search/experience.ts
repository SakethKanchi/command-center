/**
 * Read a required-experience window out of a job posting.
 *
 * Boards do not publish this as a field, so the only place it exists is prose:
 * "5+ years of experience", "3-5 years", "minimum of 2 years". Parsing it once
 * at write time turns an unfilterable sentence into two integer columns, which
 * is what makes a years-range search possible at all.
 *
 * Precision matters more than recall here. A wrong range silently hides
 * postings the candidate should see, so anything ambiguous resolves to null and
 * the posting stays visible in an unfiltered search.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Above this, the number is a typo or not about a career at all ("100 years of
 * combined experience"). Postings really do contain both.
 */
const MAX_PLAUSIBLE_YEARS = 40;

const NUMBER = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;

/**
 * Qualifiers that decide whether a number is a floor or a ceiling.
 *
 * Order is load-bearing: the regex alternation is tried left to right, so
 * "no more than" has to be offered before "more than" or the negation is read
 * as its own opposite.
 */
const LEADS: Array<{ text: string; ceiling: boolean }> = [
  { text: "no less than", ceiling: false },
  { text: "no more than", ceiling: true },
  { text: "at least", ceiling: false },
  { text: "atleast", ceiling: false },
  { text: "minimum of", ceiling: false },
  { text: "minimum", ceiling: false },
  { text: "min of", ceiling: false },
  { text: "min", ceiling: false },
  { text: "more than", ceiling: false },
  { text: "less than", ceiling: true },
  { text: "fewer than", ceiling: true },
  { text: "up to", ceiling: true },
  { text: "under", ceiling: true },
  { text: "over", ceiling: false },
];

/**
 * `(lead)? N (+)? (- M (+)?)? years`
 *
 * The trailing `(?![-\w])` keeps "2 year-long projects" out: a hyphenated
 * compound describes the work, not the hiring bar.
 */
const CANDIDATE = new RegExp(
  `(?:(${LEADS.map((lead) => lead.text).join("|")})\\s+)?(${NUMBER})\\s*\\+?\\s*` +
    `(?:(?:-|to|or)\\s*(${NUMBER})\\s*\\+?\\s*)?(?:years?|yrs?)\\b(?![-\\w])`,
  "g",
);

/**
 * Contexts where a year count describes history, not a requirement. Without
 * these, "founded 3 years ago" and "grown 4x in the last 2 years" both read as
 * junior roles.
 */
const HISTORY_BEFORE =
  /\b(?:last|past|next|previous|coming|founded|since|every)\s+$/;
const HISTORY_AFTER =
  /^\s*(?:ago|old|running|in\s+business|in\s+a\s+row|of\s+runway|of\s+cash|of\s+growth)\b/;

/** Words marking a number as being about the candidate, not the company. */
const EXPERIENCE_CUE = /\bexperience\b|\bexp\.?\b|\bbackground\b/g;

/**
 * Used only when no number survives. `rank` breaks ties inside a compound title
 * like "Senior Staff Engineer", where the later word is the operative one.
 */
const SENIORITY: Array<{
  pattern: RegExp;
  rank: number;
  minYears: number;
  maxYears: number | null;
}> = [
  {
    // A co-op term is an internship with a different university's name on it.
    pattern:
      /\b(?:interns?|internships?|co-?ops?|new\s?grads?|new graduates?|entry[-\s]level)\b/,
    rank: 0,
    minYears: 0,
    maxYears: 1,
  },
  { pattern: /\b(?:junior|jr)\b/, rank: 1, minYears: 0, maxYears: 2 },
  {
    pattern: /\bmid[-\s]?(?:level|senior)\b/,
    rank: 2,
    minYears: 2,
    maxYears: 5,
  },
  { pattern: /\b(?:senior|sr)\b/, rank: 3, minYears: 5, maxYears: null },
  {
    pattern: /\b(?:staff|principal|lead)\b/,
    rank: 4,
    minYears: 8,
    maxYears: null,
  },
];

/** How close two seniority words must sit to count as one compound title. */
const COMPOUND_TITLE_SPAN = 30;

export type ExperienceYears = {
  minYears: number | null;
  maxYears: number | null;
};

const NONE: ExperienceYears = { minYears: null, maxYears: null };

function toNumber(token: string): number | null {
  const word = NUMBER_WORDS[token];
  if (word !== undefined) return word;
  const parsed = Number.parseInt(token, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function classify(
  lead: string | undefined,
  first: number,
  second: number | null,
): ExperienceYears {
  if (second !== null) {
    return first <= second
      ? { minYears: first, maxYears: second }
      : { minYears: second, maxYears: first };
  }
  if (lead && LEADS.find((entry) => entry.text === lead)?.ceiling) {
    return { minYears: null, maxYears: first };
  }
  // A bare "5 years of experience" is a floor in every posting that writes it;
  // nobody means "exactly five", which is why `+` needs no special case.
  return { minYears: first, maxYears: null };
}

/** Drop typos and out-of-range values without discarding the usable half. */
function sanitize(range: ExperienceYears): ExperienceYears | null {
  const { minYears, maxYears } = range;
  // An absurd floor poisons the whole candidate: "50-60 years" is not "up to
  // nothing", it is a posting this parser should stay out of.
  if (minYears !== null && (minYears < 0 || minYears > MAX_PLAUSIBLE_YEARS)) {
    return null;
  }
  const capped =
    maxYears !== null && maxYears >= 0 && maxYears <= MAX_PLAUSIBLE_YEARS
      ? maxYears
      : null;
  if (minYears === null && capped === null) return null;
  return { minYears, maxYears: capped };
}

function cueIndices(text: string): number[] {
  const cues: number[] = [];
  EXPERIENCE_CUE.lastIndex = 0;
  for (
    let hit = EXPERIENCE_CUE.exec(text);
    hit;
    hit = EXPERIENCE_CUE.exec(text)
  ) {
    cues.push(hit.index);
  }
  return cues;
}

function seniorityFallback(text: string): ExperienceYears {
  const hits = SENIORITY.flatMap((entry) => {
    const index = text.search(entry.pattern);
    return index === -1 ? [] : [{ ...entry, index }];
  }).sort((a, b) => a.index - b.index);

  const first = hits[0];
  if (!first) return NONE;

  // "Senior Staff Engineer" is one title and staff is the operative word, but a
  // "senior" mentioned 400 characters into the body is describing the team.
  const chosen = hits
    .filter((hit) => hit.index - first.index <= COMPOUND_TITLE_SPAN)
    .reduce((best, hit) => (hit.rank > best.rank ? hit : best), first);
  return { minYears: chosen.minYears, maxYears: chosen.maxYears };
}

/**
 * Extract the experience window a posting asks for.
 *
 * Callers pass title and description together, title first, so a title like
 * "Senior Engineer" wins ties against body prose.
 */
export function extractExperienceYears(text: string): ExperienceYears {
  if (!text) return NONE;
  // One pass needs one shape: fold the dash zoo and collapse whitespace first.
  const haystack = text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");
  const cues = cueIndices(haystack);

  let best: { range: ExperienceYears; distance: number } | null = null;

  CANDIDATE.lastIndex = 0;
  for (
    let match = CANDIDATE.exec(haystack);
    match;
    match = CANDIDATE.exec(haystack)
  ) {
    const [whole, lead, firstToken, secondToken] = match;
    const start = match.index;
    const end = start + whole.length;

    const before = haystack.slice(Math.max(0, start - 24), start);
    const after = haystack.slice(end, end + 24);
    if (HISTORY_BEFORE.test(before) || HISTORY_AFTER.test(after)) continue;

    const first = firstToken ? toNumber(firstToken) : null;
    if (first === null) continue;
    const range = sanitize(
      classify(lead, first, secondToken ? toNumber(secondToken) : null),
    );
    if (!range) continue;

    // Several numbers in one posting is the norm ("2 week onsite", "6 month
    // contract", "5 years of experience"). The one sitting next to an
    // experience cue is the requirement; the rest are scenery.
    const distance = cues.reduce(
      (closest, cue) => Math.min(closest, Math.abs(cue - start)),
      Number.POSITIVE_INFINITY,
    );
    if (!best || distance < best.distance) best = { range, distance };
  }

  return best ? best.range : seniorityFallback(haystack);
}
