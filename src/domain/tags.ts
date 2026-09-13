/**
 * The job tag vocabulary.
 *
 * A tag is a namespaced string — `skill:python`, `level:senior` — and the
 * namespace is the whole point: it is what lets one flat column hold four
 * independent taxonomies, what lets the query say "OR within a kind, AND
 * across kinds" without a second parameter, and what a `LIKE` over a delimited
 * column could never express exactly.
 *
 * The vocabulary is CLOSED. An extractor may only emit a value listed here and
 * a query may only filter by one, because a filter whose options are open is a
 * filter that silently returns nothing for a typo. `parseJobTag` is the single
 * gate: the HTTP layer, the URL codec and the drawer all ask it the same
 * question and get the same answer.
 *
 * Each list is in DISPLAY order, not alphabetical: facets and the drawer render
 * a kind by walking its array, so the order here is the order a candidate
 * reads, and it does not reshuffle when the counts move.
 */

export const JOB_TAG_KINDS = [
  "level",
  "skill",
  "employment",
  "eligibility",
] as const;
export type JobTagKind = (typeof JOB_TAG_KINDS)[number];

/** Section headings, for a rail or a drawer that groups by kind. */
export const JOB_TAG_KIND_LABELS: Record<JobTagKind, string> = {
  level: "Level",
  skill: "Skills",
  employment: "Employment",
  eligibility: "Eligibility",
};

/**
 * Seniority, junior-most first.
 *
 * Only rungs a title actually states. There is deliberately no "lead": it is a
 * scope word on this board, attached to everything from a first promotion to a
 * director, and a rung that means six different things cannot be filtered on.
 */
export const JOB_LEVELS = [
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
] as const;
export type JobLevel = (typeof JOB_LEVELS)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "internship",
  "temporary",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * Work-authorization facts, which are the ones that decide whether applying is
 * even possible. `visa_sponsorship` and `no_sponsorship` are separate values
 * rather than one boolean because "the posting did not say" is the common case
 * and must not read as either answer.
 */
export const ELIGIBILITY_FLAGS = [
  "visa_sponsorship",
  "no_sponsorship",
  "security_clearance",
] as const;
export type EligibilityFlag = (typeof ELIGIBILITY_FLAGS)[number];

/**
 * Technologies, grouped by family so the facet reads like a stack rather than
 * like a dictionary.
 *
 * A slug earns a place only if its own spelling is unambiguous in job prose or
 * the extractor can give it surface forms. That is why `spark`, `express` and
 * a bare `c` are absent: "spark innovation", "express your ideas" and the
 * letter C appear in postings that have nothing to do with any of them, and a
 * tag that can lie is worse than a tag that is missing.
 */
export const SKILL_TAGS = [
  // Languages
  "python",
  "javascript",
  "typescript",
  "java",
  "csharp",
  "cpp",
  "go",
  "rust",
  "ruby",
  "php",
  "kotlin",
  "scala",
  "sql",
  "bash",
  // Frontend
  "react",
  "nextjs",
  "vue",
  "angular",
  "svelte",
  "css",
  "tailwind",
  "redux",
  "react_native",
  "accessibility",
  // Backend
  "nodejs",
  "dotnet",
  "django",
  "flask",
  "fastapi",
  "spring_boot",
  "ruby_on_rails",
  "graphql",
  "rest_api",
  "grpc",
  "microservices",
  // Data
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "elasticsearch",
  "snowflake",
  "bigquery",
  "kafka",
  "airflow",
  "dbt",
  "etl",
  "pandas",
  "numpy",
  "data_warehouse",
  // Machine learning
  "machine_learning",
  "deep_learning",
  "pytorch",
  "tensorflow",
  "scikit_learn",
  "nlp",
  "computer_vision",
  "llm",
  "rag",
  "huggingface",
  "vector_database",
  "mlops",
  "recommender_systems",
  // Cloud and infrastructure
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "terraform",
  "ansible",
  "ci_cd",
  "github_actions",
  "jenkins",
  "linux",
  "observability",
  "distributed_systems",
  // Mobile
  "android",
  "ios",
  "flutter",
  // Practice
  "agile",
  "unit_testing",
] as const;
export type SkillTag = (typeof SKILL_TAGS)[number];

/** The value space of each kind, so `jobTag` cannot pair a kind with another kind's value. */
export type JobTagValues = {
  level: JobLevel;
  skill: SkillTag;
  employment: EmploymentType;
  eligibility: EligibilityFlag;
};

/**
 * Every legal tag, as a union of literal strings. Spelled as a mapped type so
 * adding a value to any list above extends the union with no second edit —
 * there is no place for the two halves to disagree.
 */
export type JobTag = {
  [K in JobTagKind]: `${K}:${JobTagValues[K]}`;
}[JobTagKind];

export function jobTag<K extends JobTagKind>(
  kind: K,
  value: JobTagValues[K],
): JobTag {
  return `${kind}:${value}` as JobTag;
}

const VALUES_BY_KIND: { [K in JobTagKind]: readonly JobTagValues[K][] } = {
  level: JOB_LEVELS,
  skill: SKILL_TAGS,
  employment: EMPLOYMENT_TYPES,
  eligibility: ELIGIBILITY_FLAGS,
};

/** Membership as a lookup rather than a scan of four arrays per call. */
const KNOWN_TAGS: Record<string, true> = Object.fromEntries(
  JOB_TAG_KINDS.flatMap((kind) =>
    (VALUES_BY_KIND[kind] as readonly string[]).map(
      (value) => [`${kind}:${value}`, true] as const,
    ),
  ),
);

/**
 * Split a tag into its parts, or null when it is not in the vocabulary.
 *
 * Null covers both halves of "unknown": a malformed string and a well-formed
 * `kind:value` naming something nobody defined. Callers treat the two the same
 * way — reject — so distinguishing them would only invite a second code path.
 *
 * The tag itself comes back narrowed, which is what a caller reading tags out
 * of storage or a URL needs: the string arrives as `string` and leaves as a
 * `JobTag` only because this function vouched for it.
 */
export function parseJobTag(
  tag: string,
): { kind: JobTagKind; value: string; tag: JobTag } | null {
  if (!KNOWN_TAGS[tag]) return null;
  const separator = tag.indexOf(":");
  return {
    kind: tag.slice(0, separator) as JobTagKind,
    value: tag.slice(separator + 1),
    tag: tag as JobTag,
  };
}

/**
 * Narrowing form, for the three boundaries where tags arrive as plain strings:
 * a URL, an HTTP body, and a database column. Every one of them has to prove a
 * value is in the vocabulary before it can be treated as a tag, and a guard is
 * what lets the compiler hold them to it.
 */
export function isJobTag(value: string): value is JobTag {
  return KNOWN_TAGS[value] === true;
}

/**
 * Display spellings for values whose slug is not how anyone writes them.
 * Everything absent renders as its slug with underscores opened out, which is
 * why this table is short rather than exhaustive.
 */
const VALUE_LABELS: Record<string, string> = {
  "level:mid": "mid-level",
  "skill:csharp": "C#",
  "skill:cpp": "C++",
  "skill:javascript": "JavaScript",
  "skill:typescript": "TypeScript",
  "skill:nodejs": "Node.js",
  "skill:nextjs": "Next.js",
  "skill:dotnet": ".NET",
  "skill:rest_api": "REST API",
  "skill:graphql": "GraphQL",
  "skill:grpc": "gRPC",
  "skill:postgresql": "PostgreSQL",
  "skill:mysql": "MySQL",
  "skill:mongodb": "MongoDB",
  "skill:bigquery": "BigQuery",
  "skill:dbt": "dbt",
  "skill:etl": "ETL",
  "skill:numpy": "NumPy",
  "skill:scikit_learn": "scikit-learn",
  "skill:pytorch": "PyTorch",
  "skill:tensorflow": "TensorFlow",
  "skill:nlp": "NLP",
  "skill:llm": "LLM",
  "skill:rag": "RAG",
  "skill:huggingface": "Hugging Face",
  "skill:mlops": "MLOps",
  "skill:aws": "AWS",
  "skill:gcp": "GCP",
  "skill:ci_cd": "CI/CD",
  "skill:github_actions": "GitHub Actions",
  "skill:ios": "iOS",
  "skill:css": "CSS",
  "skill:sql": "SQL",
  "skill:php": "PHP",
  "skill:go": "Go",
  "employment:full_time": "full-time",
  "employment:part_time": "part-time",
  "eligibility:visa_sponsorship": "sponsors visas",
  "eligibility:no_sponsorship": "no sponsorship",
  "eligibility:security_clearance": "clearance required",
};

/**
 * How a tag reads in a chip: the value alone, because the chip already sits in
 * a row of filters and "skill: python" would spend half its width saying so.
 */
export function tagLabel(tag: JobTag): string {
  const known = VALUE_LABELS[tag];
  if (known) return known;
  const separator = tag.indexOf(":");
  return tag.slice(separator + 1).replace(/_/g, " ");
}
