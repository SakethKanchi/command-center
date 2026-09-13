/**
 * Tag extraction: a posting's own words, turned into the canonical vocabulary
 * in `src/domain/tags.ts`.
 *
 * Deterministic and offline by design. The model already reads a posting once,
 * during scoring, and that call costs money and is not reproducible; a filter
 * rail has to be exact and has to work on every row the moment it lands. So
 * tags are keyword-derived at write time, which also means a vocabulary change
 * is a backfill (`refreshSearchFields`) rather than a re-scoring pass.
 *
 * Three rules hold everywhere below:
 *
 * 1. No umbrella aliases. `javascript` never implies `typescript`, `aws` never
 *    implies `gcp`. A tag means the posting said that exact thing, because a
 *    filter is only useful if selecting it cannot lie.
 * 2. Matching is boundary-aware, not substring. `\b` is useless here — half
 *    this vocabulary contains `+`, `#` or `.` — so the boundaries are spelled
 *    out as lookaround over the characters that actually continue a token.
 * 3. A negative statement beats a positive one. A posting that says "no visa
 *    sponsorship" contains "visa sponsorship", and the candidate needs the
 *    veto, not the invitation.
 */

import {
  ELIGIBILITY_FLAGS,
  EMPLOYMENT_TYPES,
  JOB_LEVELS,
  type JobLevel,
  type JobTag,
  jobTag,
  SKILL_TAGS,
  type SkillTag,
} from "@domain";

/**
 * Token boundaries. The left side refuses to start mid-token and refuses a
 * preceding `.` so that "asp.net" cannot match the `.net` alias; the right side
 * allows a trailing `.` so a sentence ending in "Python." still counts.
 */
const LEFT = "(?<![a-z0-9+#.])";
const RIGHT = "(?![a-z0-9+#])";

function compile(aliases: readonly string[]): RegExp {
  const alternation = aliases
    // Longest first: "asp.net" must win over ".net" inside the same scan,
    // otherwise the shorter alias consumes the tail and the boundary check
    // fails on a string that plainly contains the technology.
    .toSorted((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`${LEFT}(?:${alternation})${RIGHT}`, "i");
}

/**
 * Surface forms per canonical skill. A slug with no entry matches its own
 * spelling, which is why most of this list is short: only genuinely ambiguous
 * or punctuation-bearing names need help.
 */
const SKILL_ALIASES: Partial<Record<SkillTag, string[]>> = {
  csharp: ["c#", "c sharp", "csharp"],
  cpp: ["c++", "cpp"],
  // "go" alone is the most common false positive in English prose, so it is
  // only trusted with a qualifier or in its "golang" spelling.
  go: ["golang", "go lang", "go developer", "go engineer", "go programming"],
  javascript: ["javascript", "js"],
  typescript: ["typescript", "ts"],
  nodejs: ["node.js", "nodejs", "node js"],
  nextjs: ["next.js", "nextjs"],
  dotnet: [".net", "dotnet", "asp.net", ".net core"],
  spring_boot: ["spring boot", "springboot", "spring framework"],
  ruby_on_rails: ["ruby on rails", "rails"],
  rest_api: ["rest api", "rest apis", "restful", "rest services"],
  grpc: ["grpc"],
  microservices: ["microservice", "microservices"],
  postgresql: ["postgresql", "postgres", "psql"],
  data_warehouse: ["data warehouse", "data warehousing"],
  etl: ["etl", "elt pipeline", "etl pipeline"],
  machine_learning: ["machine learning"],
  deep_learning: ["deep learning", "neural network", "neural networks"],
  scikit_learn: ["scikit-learn", "scikit learn", "sklearn"],
  recommender_systems: [
    "recommender system",
    "recommender systems",
    "recommendation system",
    "recommendation systems",
  ],
  ci_cd: ["ci/cd", "cicd", "continuous integration", "continuous delivery"],
  github_actions: ["github actions"],
  // The practice, not the vendor: a posting naming one tool is stating that it
  // does this, which is what the tag claims.
  observability: ["observability", "opentelemetry", "distributed tracing"],
  distributed_systems: ["distributed system", "distributed systems"],
  react_native: ["react native", "react-native"],
  computer_vision: ["computer vision", "opencv"],
  vector_database: [
    "vector database",
    "vector databases",
    "vector store",
    "vector search",
    "pinecone",
    "weaviate",
    "qdrant",
    "pgvector",
    "faiss",
  ],
  llm: ["llm", "llms", "large language model", "large language models"],
  rag: ["rag", "retrieval-augmented generation", "retrieval augmented"],
  nlp: ["nlp", "natural language processing"],
  mlops: ["mlops", "ml ops"],
  huggingface: ["hugging face", "huggingface"],
  bigquery: ["bigquery", "big query"],
  elasticsearch: ["elasticsearch", "elastic search", "opensearch"],
  kubernetes: ["kubernetes", "k8s"],
  tailwind: ["tailwind", "tailwindcss"],
  css: ["css", "scss", "sass"],
  redux: ["redux"],
  accessibility: ["accessibility", "wcag", "a11y"],
  unit_testing: ["unit test", "unit tests", "unit testing"],
  agile: ["agile", "scrum"],
  ios: ["ios", "swiftui", "uikit"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud"],
};

const SKILL_PATTERNS: Array<{ tag: JobTag; pattern: RegExp }> = SKILL_TAGS.map(
  (slug) => ({
    tag: jobTag("skill", slug),
    pattern: compile(SKILL_ALIASES[slug] ?? [slug.replace(/_/g, " ")]),
  }),
);

/**
 * Seniority markers, most senior first.
 *
 * Order is the whole algorithm: "Senior Staff Engineer" is a staff role whose
 * title happens to open with "Senior", and a leftmost-wins scan would call it
 * senior. Checking the higher rung first gets it right without a parser.
 */
const LEVEL_MARKERS: Array<{ level: JobLevel; pattern: RegExp }> = [
  { level: "principal", pattern: compile(["principal", "distinguished"]) },
  { level: "staff", pattern: compile(["staff"]) },
  { level: "senior", pattern: compile(["senior", "sr", "sr."]) },
  {
    level: "intern",
    pattern: compile(["intern", "internship", "co-op", "coop"]),
  },
  {
    level: "junior",
    pattern: compile([
      "junior",
      "jr",
      "jr.",
      "entry level",
      "entry-level",
      "new grad",
      "new graduate",
      "recent graduate",
    ]),
  },
  {
    level: "mid",
    pattern: compile(["mid-level", "mid level", "intermediate"]),
  },
];

/**
 * Titles where an internship word describes the job's subject, not its level.
 * `classifyLevel` would otherwise file the person who runs the programme as one
 * of its participants.
 */
const INTERN_GUARD =
  /intern(?:ship)?s?\s+(?:program|programme|coordinator|manager|director|lead|recruiter)/i;

/**
 * Employment patterns, listed in vocabulary order so a filtered scan already
 * yields tags in the order the facet reports them.
 */
const EMPLOYMENT_PATTERNS: Array<{ tag: JobTag; pattern: RegExp }> = [
  {
    tag: jobTag("employment", "full_time"),
    pattern: compile(["full-time", "full time", "fulltime", "permanent role"]),
  },
  {
    tag: jobTag("employment", "part_time"),
    pattern: compile(["part-time", "part time", "parttime"]),
  },
  {
    tag: jobTag("employment", "contract"),
    // Never a bare "contract": every posting that mentions contract law,
    // contract negotiation or a contract renewal would become a contract role.
    pattern: compile([
      "contract role",
      "contract position",
      "contract basis",
      "contract opportunity",
      "contract-to-hire",
      "contract to hire",
      "contractor",
      "fixed-term",
      "fixed term contract",
      "w2 contract",
      "1099",
      "c2c",
    ]),
  },
  {
    tag: jobTag("employment", "internship"),
    pattern: compile(["internship", "intern position", "summer intern"]),
  },
  {
    tag: jobTag("employment", "temporary"),
    pattern: compile([
      "temporary position",
      "temporary role",
      "temporary assignment",
      "temp role",
      "seasonal",
    ]),
  },
];

const NO_SPONSORSHIP = compile([
  "no sponsorship",
  "no visa sponsorship",
  "without sponsorship",
  "unable to sponsor",
  "not able to sponsor",
  "cannot sponsor",
  "does not sponsor",
  "do not sponsor",
  "will not sponsor",
  "sponsorship is not available",
  "not provide sponsorship",
  "no h-1b",
  "no h1b",
]);

const VISA_SPONSORSHIP = compile([
  "visa sponsorship",
  "sponsorship available",
  "sponsorship provided",
  "will sponsor",
  "we sponsor",
  "sponsor visas",
  "h-1b sponsor",
  "h1b sponsor",
  "green card sponsorship",
]);

const SECURITY_CLEARANCE = compile([
  "security clearance",
  "active clearance",
  "secret clearance",
  "top secret",
  "ts/sci",
  "public trust",
]);

/**
 * The seniority a title states, or null when it states none.
 *
 * Deliberately does not fall back to the years-of-experience line: "5+ years"
 * is a requirement, not a rung, and a guessed level sitting in the same
 * namespace as a stated one would make the level filter unfalsifiable.
 */
export function classifyLevel(title: string): JobLevel | null {
  const guarded = INTERN_GUARD.test(title);
  for (const { level, pattern } of LEVEL_MARKERS) {
    if (level === "intern" && guarded) continue;
    if (pattern.test(title)) return level;
  }
  return null;
}

/**
 * Every tag a posting earns, in vocabulary order so two postings with the same
 * tags always store them in the same order.
 */
export function extractJobTags(input: {
  title: string;
  descriptionText?: string | null;
}): JobTag[] {
  const title = input.title;
  const body = `${title}\n${input.descriptionText ?? ""}`;
  const tags: JobTag[] = [];

  const level = classifyLevel(title);
  if (level) tags.push(jobTag("level", level));

  for (const { tag, pattern } of SKILL_PATTERNS) {
    if (pattern.test(body)) tags.push(tag);
  }

  // A posting can honestly carry more than one employment type: "full-time or
  // contract" is a real sentence, and dropping one of the two would hide the
  // posting from a filter that asks for the other. The pattern list is already
  // in vocabulary order, so a filtered scan needs no sort.
  for (const { tag, pattern } of EMPLOYMENT_PATTERNS) {
    if (pattern.test(body)) tags.push(tag);
  }

  // Negative precedence: a posting saying "no visa sponsorship" contains the
  // positive phrase too, and the candidate needs the veto rather than the
  // invitation. Clearance is independent of either.
  if (NO_SPONSORSHIP.test(body)) {
    tags.push(jobTag("eligibility", "no_sponsorship"));
  } else if (VISA_SPONSORSHIP.test(body)) {
    tags.push(jobTag("eligibility", "visa_sponsorship"));
  }
  if (SECURITY_CLEARANCE.test(body)) {
    tags.push(jobTag("eligibility", "security_clearance"));
  }

  return tags;
}

/**
 * Vocabulary position per tag, so a facet list is ordered by the vocabulary
 * rather than by count and a rail's rows do not reshuffle on every keystroke.
 *
 * Keyed by plain string rather than by `JobTag`: callers look up tags read
 * back out of storage, which may still hold a value a vocabulary change has
 * since dropped. Those sort to the front on `?? 0` and are filtered out where
 * it matters, rather than making every lookup site cast.
 */
export const TAG_ORDER: Record<string, number> = Object.fromEntries(
  [
    ...JOB_LEVELS.map((value) => jobTag("level", value)),
    ...SKILL_TAGS.map((value) => jobTag("skill", value)),
    ...EMPLOYMENT_TYPES.map((value) => jobTag("employment", value)),
    ...ELIGIBILITY_FLAGS.map((value) => jobTag("eligibility", value)),
  ].map((tag, index) => [tag, index]),
);
