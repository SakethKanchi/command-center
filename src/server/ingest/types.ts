import type { NewJob } from "@domain";
import { badRequest, forbidden, upstreamError } from "@server/infra/errors";
import { fetchWithRetry } from "@server/infra/retry";

/**
 * The contract every job board plugs into.
 *
 * An adapter owns exactly one thing: turning a board's wire shape into
 * `NewJob`. It never touches the database and never reaches for a global
 * `fetch` — the caller injects the transport, which is what lets the whole
 * ingest path run in tests against recorded payloads with no network.
 */
export type SourceAdapter = {
  readonly id: string;
  readonly label: string;
  /** True for per-company ATS boards, which cannot be queried without a token. */
  readonly needsBoardToken: boolean;
  fetchJobs(input: FetchJobsInput): Promise<NewJob[]>;
};

export type FetchJobsInput = {
  /** Board token for an ATS source, e.g. the `acme` in `jobs.ashbyhq.com/acme`. */
  board?: string;
  /** Free-text query for an aggregator source. Ignored by ATS boards. */
  query?: string;
  /**
   * Free-text place the candidate asked for. An adapter pushes it upstream in
   * whatever vocabulary its board accepts, and filters locally when the board
   * has no way to express it. A board that cannot filter by place at all —
   * every ATS here publishes one company's postings and nothing else —
   * ignores this.
   */
  location?: string;
  /** Work mode, when the candidate has an opinion. */
  remote?: boolean;
  limit: number;
  fetchImpl: typeof fetch;
  /**
   * Where an adapter says what actually became of the filters: which
   * parameters the board honoured, and what it had to apply itself afterwards.
   *
   * Pushed into rather than returned because `fetchJobs` returns postings, and
   * a board that quietly ignored the location has to be able to say so without
   * every adapter growing a second return channel it does not use.
   */
  notes?: string[];
};

const USER_AGENT = "command-center/0.1 (+job-search agent)";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A pathological posting body must not become a 2 MB database row and a
 * five-figure token bill on the next scoring pass. Bodies in the wild top out
 * around 10 KB, so this cap only ever truncates an outlier.
 */
export const DESCRIPTION_MAX_CHARS = 20_000;

/**
 * Fetch JSON from an allowlisted host.
 *
 * Every adapter goes through here rather than calling `fetchWithRetry`
 * directly, so the two SSRF guards — host allowlist and `redirect: "error"` —
 * cannot be forgotten in one adapter and present in the other three. The
 * allowlist is checked against the exact string that goes over the wire,
 * query parameters included.
 */
export async function fetchSourceJson(input: {
  url: string;
  label: string;
  allowedHosts: HostAllowlist;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
  const url = assertAllowedUrl(input.url, input.allowedHosts, input.label);
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      // Blocks the redirect hop out of the allowlist that the host check above
      // cannot see.
      redirect: "error",
    },
    {
      fetchImpl: input.fetchImpl,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: input.label,
    },
  );

  if (!response.ok) {
    throw upstreamError(`${input.label}: HTTP ${response.status}`, {
      status: response.status,
      url,
    });
  }

  try {
    return await response.json();
  } catch {
    throw upstreamError(`${input.label}: response was not valid JSON`, { url });
  }
}

/** Literal host table per adapter. `Record` rather than `Set`: it is static. */
export type HostAllowlist = Readonly<Record<string, true>>;

/**
 * Refuse any URL that is not HTTPS on a host the adapter declared.
 *
 * The allowlist is a literal table per adapter, never a suffix match: a
 * `*.greenhouse.io` style check is satisfied by `evil.greenhouse.io.attacker
 * .com` under a naive implementation, and by a subdomain takeover under a
 * careful one.
 */
export function assertAllowedUrl(
  rawUrl: string,
  allowedHosts: HostAllowlist,
  label: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest(`${label}: invalid URL`, { url: rawUrl });
  }
  if (parsed.protocol !== "https:") {
    throw forbidden(`${label}: refused non-HTTPS URL "${rawUrl}"`);
  }
  if (allowedHosts[parsed.hostname] !== true) {
    throw forbidden(
      `${label}: refused host "${parsed.hostname}" — allowed: ${Object.keys(allowedHosts).join(", ")}`,
    );
  }
  return parsed.href;
}

const SAFE_BOARD_TOKEN = /^[A-Za-z0-9._~-]+$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Validate a board token and escape it for use as a single path segment.
 *
 * The token is the one part of an ATS URL that comes from outside, so it is
 * the whole attack surface: `../..%2fevil` or `http://169.254.169.254` in that
 * slot would otherwise re-point a request that already passed the host check.
 * Rejected rather than sanitized — a token that needed rewriting was never a
 * real board.
 */
export function boardToken(raw: string | undefined, label: string): string {
  const token = (raw ?? "").trim();
  if (token === "") {
    throw badRequest(`${label}: a board token is required`);
  }
  if (token.includes("/") || token.includes("\\")) {
    throw badRequest(`${label}: board token must be a single path segment`, {
      token,
    });
  }
  if (token.includes("..")) {
    throw badRequest(`${label}: board token must not traverse paths`, {
      token,
    });
  }
  if (URL_SCHEME.test(token)) {
    throw badRequest(`${label}: board token must not be a URL`, { token });
  }
  if (!SAFE_BOARD_TOKEN.test(token)) {
    throw badRequest(`${label}: board token has unsupported characters`, {
      token,
    });
  }
  // A no-op for the charset above, kept so the escaping guarantee survives any
  // future widening of that charset.
  return encodeURIComponent(token);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  deg: "°",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  middot: "·",
  euro: "€",
  eacute: "é",
  egrave: "è",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
};

/** Matched case-insensitively because legacy pages really do write `&AMP;`. */
const CASE_INSENSITIVE_NAMES: Readonly<Record<string, true>> = {
  amp: true,
  lt: true,
  gt: true,
  quot: true,
  apos: true,
  nbsp: true,
};

const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

/**
 * Only the code points XML 1.0 §2.2 permits.
 *
 * A bare `<= 0x10FFFF` bound stops `fromCodePoint` throwing but still admits
 * NUL, the C0 controls and lone surrogates — and a decoded description is not
 * displayed and discarded, it is persisted, re-serialized and sent to an LLM.
 * A visible literal `&#0;` is inert; a decoded NUL is not.
 */
function isEmittableCodePoint(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

export function decodeEntities(value: string): string {
  return value.replace(ENTITY, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return isEmittableCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (Object.hasOwn(NAMED_ENTITIES, body))
      return NAMED_ENTITIES[body] as string;
    const lower = body.toLowerCase();
    const named = CASE_INSENSITIVE_NAMES[lower]
      ? NAMED_ENTITIES[lower]
      : undefined;
    return named ?? match;
  });
}

const MEDIA =
  /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
// A tag ends at an unquoted `>`. The usual `<[^>]+>` shortcut stops at the
// first `>` inside an attribute value and spills the rest of the attributes
// into the text. A `<` that is not followed by a tag name, `!` or `?` is not
// a tag at all, and matching it anyway eats the prose between it and the next
// `>` — "Salary < 100k and > 50k" would come out as "Salary 50k".
const TAG =
  /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[^>"']|"[^"]*"|'[^']*')*>|<[!?][^>]*>/g;
/** `&lt;p&gt;`, `&lt;/div&gt;` — a tag that survived JSON encoding. */
const ESCAPED_TAG = /&lt;\/?[a-zA-Z][^&]*&gt;/;

/**
 * A markdown horizontal rule, which survives tag stripping and then reads as
 * line noise once the newlines around it are collapsed. Aggregators that
 * render descriptions as markdown emit these between every section.
 *
 * Three or more, so hyphenated words and an en-dash range are untouched.
 */
const HORIZONTAL_RULE = /(?<=^|\s)[-=_]{3,}(?=\s|$)/g;

/**
 * Tags that sit inside a sentence. Removing one must not leave a space
 * behind, or `<strong>Engineer</strong>.` reads as `Engineer .`.
 */
const INLINE_TAGS: Readonly<Record<string, true>> = {
  a: true,
  abbr: true,
  b: true,
  big: true,
  cite: true,
  code: true,
  em: true,
  font: true,
  i: true,
  kbd: true,
  label: true,
  mark: true,
  q: true,
  s: true,
  samp: true,
  small: true,
  span: true,
  strike: true,
  strong: true,
  sub: true,
  sup: true,
  time: true,
  tt: true,
  u: true,
  var: true,
};

/**
 * Markup → readable plain text.
 *
 * A block tag becomes a space so `…experience.</p><p>You will…` does not come
 * out as `experience.You will`; an inline tag becomes nothing so the same rule
 * does not shove a space in front of every comma. Whitespace is collapsed
 * afterwards, which makes the result independent of how the board indented.
 *
 * The one conditional decode handles Greenhouse, which ships posting bodies
 * entity-escaped inside JSON (`&lt;p&gt;`) so the markup is only strippable
 * after a decode. Doing that decode unconditionally is what breaks prose:
 * `latency &lt; 50ms &gt; p99` would decode into something the tag stripper
 * then eats the middle of.
 */
export function htmlToText(input: unknown): string {
  if (typeof input !== "string" || input === "") return "";
  const markup = ESCAPED_TAG.test(input) ? decodeEntities(input) : input;
  const stripped = markup
    .replace(MEDIA, " ")
    .replace(COMMENT, " ")
    .replace(TAG, (_match, name: string | undefined) =>
      name !== undefined && INLINE_TAGS[name.toLowerCase()] === true ? "" : " ",
    );
  return decodeEntities(stripped)
    .replace(HORIZONTAL_RULE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS);
}

/**
 * A date-time with no zone on it, as Remotive and other feeds publish:
 * `2026-09-11T20:16:48`, occasionally with a space instead of the `T`.
 */
const ZONELESS_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Any timestamp a board might emit → ISO-8601 UTC, or null.
 *
 * Numbers are epoch: Lever sends milliseconds, some boards send seconds. The
 * 1e11 split tells them apart — as seconds that is the year 5138, as
 * milliseconds it is 1973, and no posting is plausibly either.
 *
 * A zoneless date-time is read as UTC rather than as host-local time.
 * `Date.parse` does the opposite per ECMAScript — a date-only string is UTC, a
 * date-*time* without an offset is local — which would make one recorded
 * payload produce different rows on two machines, and shift a posting across a
 * day boundary on any host west of Greenwich. Boards publish UTC; the offset
 * of whatever machine ran the ingest is not data.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const zoneless = ZONELESS_DATETIME.exec(trimmed);
  const parsed = Date.parse(
    zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed,
  );
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const REMOTE_HINT =
  /\b(?:fully[\s-]?)?remote\b|\bwork from home\b|\banywhere\b|\bdistributed\b/i;

/**
 * Derive the remote flag from whatever the board exposes.
 *
 * An explicit workplace type wins over the location string, and over a bare
 * `isRemote` boolean: boards in the wild carry `isRemote: true` next to
 * `workplaceType: "Hybrid"` for office-anchored roles, and trusting the
 * boolean there mislabels them. Null when the board says nothing at all —
 * "unknown" and "not remote" are different answers to the filter downstream.
 */
export function detectRemote(input: {
  workplaceType?: unknown;
  isRemote?: unknown;
  location?: string | null;
}): boolean | null {
  const workplace =
    typeof input.workplaceType === "string"
      ? input.workplaceType.trim().toLowerCase()
      : "";
  if (workplace !== "") return workplace === "remote";
  if (typeof input.isRemote === "boolean") return input.isRemote;
  const location = input.location?.trim();
  if (!location) return null;
  return REMOTE_HINT.test(location);
}

/**
 * `acme-corp` → `Acme Corp`.
 *
 * Greenhouse, Ashby and Lever all identify the employer by board token alone
 * on their list endpoints, and a raw slug reads as a bug in the UI and in a
 * generated cover letter.
 */
export function humanizeBoardToken(token: string): string {
  return decodeURIComponent(token)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3
        ? word.toUpperCase()
        : word[0]?.toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** Trimmed non-empty string, or null. Boards are generous with `""`. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Split a location fragment into comparable segments: "Calgary, Canada" -> {calgary, canada}. */
function locationSegments(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[,·/|]+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0),
  );
}

/**
 * Join location fragments in first-seen order, dropping redundant ones.
 *
 * Boards hand back overlapping views of the same place: a posting line
 * "Calgary, Canada" plus a city facet "Calgary" plus a country facet "CA".
 * Concatenating them blindly renders "Calgary, Canada · Calgary · CA", which
 * reads like three locations. A fragment is therefore dropped when all of its
 * segments already appear in a fragment we kept.
 */
export function joinLocations(
  parts: Array<string | null | undefined>,
): string | null {
  const kept: string[] = [];
  const keptSegments: Array<Set<string>> = [];

  for (const part of parts) {
    const value = part?.trim();
    if (!value) continue;

    const segments = locationSegments(value);
    if (segments.size === 0) continue;

    const isRedundant = keptSegments.some((existing) =>
      [...segments].every((segment) => existing.has(segment)),
    );
    if (isRedundant) continue;

    kept.push(value);
    keptSegments.push(segments);
  }

  return kept.length === 0 ? null : kept.join(" · ");
}

/**
 * Drop a trailing company name from a job title.
 *
 * Some boards publish "Senior Full Stack Engineer at RBC" with the company
 * *also* in its own field. Left alone that duplication propagates everywhere:
 * the dashboard row, the agent's run goal ("Apply to ... at RBC at RBC"), and
 * the scoring prompt, where it wastes tokens restating a fact already given.
 *
 * Only an exact case-insensitive match on the company is removed, and only as a
 * trailing segment, so a genuine title like "Engineer at Scale" survives unless
 * the employer really is called "Scale".
 */
export function stripCompanyFromTitle(title: string, company: string): string {
  const needle = company.trim().toLowerCase();
  if (needle.length === 0) return title;

  const trimmed = title.trim();
  for (const separator of [" at ", " @ ", " - ", " – ", " — ", ", "]) {
    const index = trimmed.toLowerCase().lastIndexOf(separator + needle);
    if (
      index > 0 &&
      index + separator.length + needle.length === trimmed.length
    ) {
      return trimmed.slice(0, index).trim();
    }
  }
  return trimmed;
}

/**
 * Word characters plus the three punctuation marks that carry meaning inside a
 * technology name — `c++`, `c#`, `node.js`. Splitting on those would turn one
 * token into three that match almost every posting.
 */
const KEYWORD_SEPARATORS = /[^\p{L}\p{N}+#.]+/u;

/**
 * Tokens a posting has to contain to count as a keyword hit.
 *
 * Single characters are dropped: a stray "a" or "&" from "R&D" matches every
 * body ever written, so keeping it would make the filter a no-op while looking
 * like it applied.
 */
export function keywordTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(KEYWORD_SEPARATORS)
    .filter((token) => token.length > 1);
}

/**
 * Keyword match for a board that has no search parameter.
 *
 * Three of the aggregators here publish a firehose and nothing else: the only
 * way to honour a query against them is to fetch pages and match locally. AND
 * across tokens rather than OR — "backend engineer" must not return every
 * posting containing the word "engineer", which is the failure mode that makes
 * a keyword box feel broken.
 *
 * The body is part of the haystack because a title alone is too small a target:
 * "Platform Engineer" is a real answer to "kubernetes" and its title says so
 * nowhere.
 */
export function matchesKeyword(job: NewJob, query: string): boolean {
  const tokens = keywordTokens(query);
  if (tokens.length === 0) return true;
  const haystack = [
    job.title,
    job.company,
    job.location ?? "",
    job.descriptionText,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
