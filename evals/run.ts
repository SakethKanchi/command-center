/**
 * Golden-set eval runner for this repo's LLM job scoring and resume tailoring.
 *
 * Ported from `career-ops/eval-golden.mjs`: labelled golden cases, a replay mode
 * that reads recorded model output so CI runs are deterministic and free, a
 * `--live` mode that calls the configured provider, and a hard gate on
 * agreement-with-reference.
 *
 * Subjects under evaluation:
 *   - scoring   -> `scoreJob` / `JOB_SCORING_SCHEMA`
 *                  (src/server/llm/score-job.ts)
 *   - tailoring -> `tailorResume` / `RESUME_TAILORING_SCHEMA`
 *                  (src/server/llm/tailor-resume.ts)
 *
 * The replay path touches no network and reads no API-key environment variable.
 * Everything credential-shaped lives behind the `--live` branch.
 *
 * Usage:
 *   npx tsx evals/run.ts --replay                 # offline, deterministic, $0 (default)
 *   npx tsx evals/run.ts --replay --json          # machine-readable, for CI
 *   npx tsx evals/run.ts --case <id>              # one case
 *   npx tsx evals/run.ts --live                   # calls the configured provider
 *   npx tsx evals/run.ts --live --update-fixtures # re-record the replay fixtures
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CaseResult,
  DEFAULT_GATES,
  deriveScoringObservation,
  deriveTailoringObservation,
  type EvalGates,
  evaluateGates,
  formatReport,
  type GateResult,
  type GoldenCase,
  type GoldenCaseExpectation,
  type ScoringOutput,
  scoreAgreement,
  type TailoringOutput,
} from "./scoring";

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Every outbound call gets a deadline, like every adapter in `src/server`. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Bounded retry, mirroring `isRetryableStatus` / `backoffDelayMs` in `src/server/infra/retry.ts`. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

interface EvalCaseInput {
  job: {
    id: string;
    title: string;
    employer: string;
    location: string | null;
    isRemote: boolean;
    salary: string | null;
    jobLevel: string | null;
    jobDescription: string;
  };
  candidate: Record<string, unknown>;
}

interface EvalCase extends GoldenCase {
  input: EvalCaseInput;
  file: string;
}

interface CliOptions {
  mode: "replay" | "live";
  caseId: string | null;
  json: boolean;
  updateFixtures: boolean;
  casesDir: string;
  fixturesDir: string;
  gates: EvalGates;
}

const USAGE = `
golden-set eval — scoring + tailoring agreement against frozen reference verdicts

  --replay                 replay recorded fixtures; no network, no API key (default)
  --live                   call the configured LLM provider (LLM_API_KEY, LLM_BASE_URL, MODEL)
  --update-fixtures        re-record fixtures from a live run; requires --live
  --case <id>              run a single case by id
  --json                   print machine-readable JSON instead of the table
  --cases <dir>            golden-case directory (default evals/cases)
  --fixtures <dir>         fixture directory (default evals/fixtures)
  --gate-label <fraction>  override the label-agreement gate (default ${DEFAULT_GATES.minLabelAgreement})
  --gate-tolerance <frac>  override the score-within-tolerance gate (default ${DEFAULT_GATES.minWithinTolerance})
  -h, --help               this text

Exit code is 0 only when every gate passes and every case produced an observation.
`.trim();

function fail(message: string): never {
  process.stderr.write(`eval: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "replay",
    caseId: null,
    json: false,
    updateFixtures: false,
    casesDir: join(ROOT, "cases"),
    fixturesDir: join(ROOT, "fixtures"),
    gates: { ...DEFAULT_GATES },
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${flag} needs a value`);
    }
    return value;
  };

  const fraction = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fail(`${flag} needs a fraction between 0 and 1, got "${raw}"`);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      case "--replay":
        options.mode = "replay";
        break;
      case "--live":
        options.mode = "live";
        break;
      case "--json":
        options.json = true;
        break;
      case "--update-fixtures":
        options.updateFixtures = true;
        break;
      case "--case":
        options.caseId = next(index, arg);
        index += 1;
        break;
      case "--cases":
        options.casesDir = resolve(next(index, arg));
        index += 1;
        break;
      case "--fixtures":
        options.fixturesDir = resolve(next(index, arg));
        index += 1;
        break;
      case "--gate-label":
        options.gates.minLabelAgreement = fraction(next(index, arg), arg);
        index += 1;
        break;
      case "--gate-tolerance":
        options.gates.minWithinTolerance = fraction(next(index, arg), arg);
        index += 1;
        break;
      default:
        fail(`unknown flag "${arg}"\n\n${USAGE}`);
    }
  }

  if (options.updateFixtures && options.mode !== "live") {
    fail(
      "--update-fixtures rewrites the replay fixtures from real model output, so it requires --live. " +
        "Re-run as: npx tsx evals/run.ts --live --update-fixtures",
    );
  }

  return options;
}

/**
 * The one canonical object guard for this standalone harness. `evals/` ships no
 * schema validator on purpose — the replay path must stay dependency-free — so
 * every JSON boundary below narrows with this guard and then checks each field
 * it actually uses with `typeof`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as string[];
}

function parseCase(raw: unknown, file: string): EvalCase {
  if (!isRecord(raw)) fail(`${file}: case file must contain a JSON object`);

  const id = requireString(raw, "id", file);
  const kind = requireString(raw, "kind", file);
  if (kind !== "scoring" && kind !== "tailoring") {
    fail(`${file}: "kind" must be "scoring" or "tailoring", got "${kind}"`);
  }

  const expectedRaw = raw.expected;
  if (!isRecord(expectedRaw)) fail(`${file}: "expected" must be an object`);
  const label = requireString(expectedRaw, "label", `${file} expected`);
  const score = expectedRaw.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    fail(`${file}: "expected.score" must be a finite number`);
  }
  const tolerance = expectedRaw.tolerance;
  if (
    tolerance !== undefined &&
    (typeof tolerance !== "number" ||
      !Number.isFinite(tolerance) ||
      tolerance < 0)
  ) {
    fail(`${file}: "expected.tolerance" must be a non-negative number`);
  }

  const inputRaw = raw.input;
  if (!isRecord(inputRaw)) fail(`${file}: "input" must be an object`);
  const jobRaw = inputRaw.job;
  if (!isRecord(jobRaw)) fail(`${file}: "input.job" must be an object`);
  const candidateRaw = inputRaw.candidate;
  if (!isRecord(candidateRaw))
    fail(`${file}: "input.candidate" must be an object`);

  const expected: GoldenCaseExpectation = {
    label,
    score,
    tolerance: typeof tolerance === "number" ? tolerance : undefined,
    requiredKeywords: stringArray(expectedRaw.requiredKeywords),
    forbiddenFabrications: stringArray(expectedRaw.forbiddenFabrications),
    provenance:
      typeof expectedRaw.provenance === "string"
        ? expectedRaw.provenance
        : undefined,
  };

  if (kind === "tailoring" && (expected.requiredKeywords?.length ?? 0) === 0) {
    fail(
      `${file}: tailoring cases need a non-empty "expected.requiredKeywords"`,
    );
  }

  return {
    id,
    kind,
    expected,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    file,
    input: {
      job: {
        id: requireString(jobRaw, "id", `${file} input.job`),
        title: requireString(jobRaw, "title", `${file} input.job`),
        employer: requireString(jobRaw, "employer", `${file} input.job`),
        location: typeof jobRaw.location === "string" ? jobRaw.location : null,
        isRemote: jobRaw.isRemote === true,
        salary: typeof jobRaw.salary === "string" ? jobRaw.salary : null,
        jobLevel: typeof jobRaw.jobLevel === "string" ? jobRaw.jobLevel : null,
        jobDescription: requireString(
          jobRaw,
          "jobDescription",
          `${file} input.job`,
        ),
      },
      candidate: candidateRaw,
    },
  };
}

function loadCases(dir: string, caseId: string | null): EvalCase[] {
  if (!existsSync(dir)) fail(`golden-case directory not found: ${dir}`);

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) fail(`no golden cases (*.json) in ${dir}`);

  const cases = files.map((name) => {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      fail(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseCase(parsed, path);
  });

  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) fail(`duplicate case id "${testCase.id}"`);
    ids.add(testCase.id);
  }

  // Scoring lane first, then hardest-to-easiest reference verdict: the table
  // reads as a ranked list instead of an alphabetical shuffle.
  cases.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      b.expected.score - a.expected.score ||
      a.id.localeCompare(b.id),
  );

  if (caseId === null) return cases;
  const selected = cases.filter((testCase) => testCase.id === caseId);
  if (selected.length === 0) {
    fail(`no case with id "${caseId}" in ${dir}`);
  }
  return selected;
}

/** A recorded model output, one file per case. */
interface Fixture {
  caseId: string;
  kind: "scoring" | "tailoring";
  model?: string;
  output: ScoringOutput | TailoringOutput;
}

function readFixture(
  dir: string,
  testCase: EvalCase,
): Fixture | { missing: string } {
  const path = join(dir, `${testCase.id}.json`);
  if (!existsSync(path)) return { missing: path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.output)) {
    fail(`${path}: fixture must be an object with an "output" object`);
  }
  return {
    caseId: testCase.id,
    kind: testCase.kind,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    output: parsed.output as unknown as ScoringOutput | TailoringOutput,
  };
}

function observe(
  testCase: EvalCase,
  output: ScoringOutput | TailoringOutput,
): CaseResult {
  if (testCase.kind === "scoring") {
    // Field-checked immediately below; the fixture/live boundary cannot type itself.
    const scoring = output as ScoringOutput;
    if (typeof scoring.score !== "number" || !Number.isFinite(scoring.score)) {
      return {
        caseId: testCase.id,
        error: "scoring output carried no numeric score",
      };
    }
    const derived = deriveScoringObservation(scoring);
    return { caseId: testCase.id, ...derived };
  }

  const tailoring = output as TailoringOutput;
  if (
    typeof tailoring.summary !== "string" ||
    tailoring.summary.trim() === ""
  ) {
    return {
      caseId: testCase.id,
      error: "tailoring output carried no summary",
    };
  }
  const derived = deriveTailoringObservation(
    {
      headline:
        typeof tailoring.headline === "string" ? tailoring.headline : "",
      summary: tailoring.summary,
      skills: Array.isArray(tailoring.skills)
        ? tailoring.skills.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    },
    testCase.expected,
  );
  return { caseId: testCase.id, ...derived };
}

// ---------------------------------------------------------------------------
// Live mode. Nothing below this line runs on the replay path.
// ---------------------------------------------------------------------------

interface LiveConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Resolve provider credentials from the same environment variables the server
 * reads (`LLM_API_KEY`, `LLM_BASE_URL`, `MODEL`). Called only from
 * the `--live` branch so the replay path never touches a credential.
 */
function resolveLiveConfig(): LiveConfig {
  const apiKey =
    process.env.LLM_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  if (apiKey === "") {
    fail(
      "live mode needs a provider key in LLM_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY). " +
        "Replay mode needs no credentials: npx tsx evals/run.ts --replay",
    );
  }
  const baseUrl = (
    process.env.LLM_BASE_URL?.trim() || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "");
  const model = process.env.MODEL?.trim() || "";
  if (model === "") {
    fail(
      "live mode needs a model id in MODEL (for example MODEL=google/gemini-3-flash-preview)",
    );
  }
  return { apiKey, baseUrl, model };
}

const SCORING_JSON_SCHEMA = {
  name: "eval_job_suitability_score",
  strict: true,
  schema: {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string" },
    },
    required: ["score", "reason"],
    additionalProperties: false,
  },
} as const;

const TAILORING_JSON_SCHEMA = {
  name: "eval_resume_tailoring",
  strict: true,
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      skills: { type: "array", items: { type: "string" } },
    },
    required: ["headline", "summary", "skills"],
    additionalProperties: false,
  },
} as const;

function buildPrompt(testCase: EvalCase): string {
  const job = testCase.input.job;
  const facts = [
    `TITLE: ${job.title}`,
    `EMPLOYER: ${job.employer}`,
    `LOCATION: ${job.location ?? "Not stated"}`,
    `REMOTE: ${job.isRemote ? "yes" : "not stated"}`,
    `SALARY: ${job.salary ?? "Not stated"}`,
    `LEVEL: ${job.jobLevel ?? "Not stated"}`,
  ].join("\n");
  const candidate = JSON.stringify(testCase.input.candidate, null, 2);

  if (testCase.kind === "scoring") {
    return [
      "Score how suitable this candidate is for the job on a 0-100 scale.",
      "Weigh required years of experience, required stack, location and remote policy, and hard filters such as clearances or degrees. Use only stated job facts.",
      "",
      "CANDIDATE PROFILE:",
      candidate,
      "",
      "JOB DATA:",
      facts,
      "",
      "JOB DESCRIPTION:",
      job.jobDescription,
      "",
      'Respond with ONLY valid JSON: {"score": <integer 0-100>, "reason": "<1-2 sentences>"}',
    ].join("\n");
  }

  return [
    "Write tailored resume content for this candidate and job: a headline, a summary of at most 120 words, and a flat list of skill keywords.",
    "Use only skills and experience the candidate profile supports. Never claim a credential, clearance, degree, or tenure that is not in the profile.",
    "",
    "CANDIDATE PROFILE:",
    candidate,
    "",
    "JOB DATA:",
    facts,
    "",
    "JOB DESCRIPTION:",
    job.jobDescription,
    "",
    'Respond with ONLY valid JSON: {"headline": "<headline>", "summary": "<summary>", "skills": ["<keyword>"]}',
  ].join("\n");
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.floor(seconds * 1000);
  const dateMs = Date.parse(header.trim());
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

async function callLive(
  testCase: EvalCase,
  config: LiveConfig,
): Promise<ScoringOutput | TailoringOutput> {
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: "user", content: buildPrompt(testCase) }],
    response_format: {
      type: "json_schema",
      json_schema:
        testCase.kind === "scoring"
          ? SCORING_JSON_SCHEMA
          : TAILORING_JSON_SCHEMA,
    },
  });

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      // Retry only rate limits and server faults, as the LLM retry policy does.
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}`;
        const retryAfter = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        if (attempt === MAX_ATTEMPTS) break;
        const backoff =
          Math.random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        const { promise, resolve: wake } = Promise.withResolvers<void>();
        setTimeout(wake, Math.max(1, Math.floor((retryAfter ?? 0) + backoff)));
        await promise;
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }

      const payload: unknown = await response.json();
      const content =
        isRecord(payload) &&
        Array.isArray(payload.choices) &&
        isRecord(payload.choices[0])
          ? (payload.choices[0].message as Record<string, unknown> | undefined)
              ?.content
          : undefined;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("no content in response");
      }
      const parsed: unknown = JSON.parse(
        content.replace(/^```(?:json)?|```$/g, "").trim(),
      );
      if (!isRecord(parsed))
        throw new Error("completion was not a JSON object");
      return parsed as unknown as ScoringOutput | TailoringOutput;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `live call failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

function writeFixture(
  dir: string,
  testCase: EvalCase,
  output: ScoringOutput | TailoringOutput,
  config: LiveConfig,
): void {
  const path = join(dir, `${testCase.id}.json`);
  const fixture = {
    caseId: testCase.id,
    kind: testCase.kind,
    recordedFrom:
      "live provider call via evals/run.ts --live --update-fixtures",
    recordedBy: `${config.baseUrl}`,
    recordedAt: new Date().toISOString(),
    model: config.model,
    output,
  };
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases(options.casesDir, options.caseId);

  const results: CaseResult[] = [];
  const errors: string[] = [];
  let model = "recorded-production-run";

  if (options.mode === "replay") {
    for (const testCase of cases) {
      const fixture = readFixture(options.fixturesDir, testCase);
      if ("missing" in fixture) {
        errors.push(
          `missing replay fixture for case "${testCase.id}": ${fixture.missing}`,
        );
        results.push({ caseId: testCase.id, error: "replay fixture missing" });
        continue;
      }
      if (fixture.model) model = fixture.model;
      results.push(observe(testCase, fixture.output));
    }
  } else {
    const config = resolveLiveConfig();
    model = config.model;
    for (const testCase of cases) {
      const startedAt = Date.now();
      try {
        const output = await callLive(testCase, config);
        const latencyMs = Date.now() - startedAt;
        results.push({ ...observe(testCase, output), latencyMs });
        if (options.updateFixtures) {
          writeFixture(options.fixturesDir, testCase, output, config);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`case "${testCase.id}": ${message}`);
        results.push({
          caseId: testCase.id,
          error: message,
          latencyMs: Date.now() - startedAt,
        });
      }
    }
  }

  const report = scoreAgreement(cases, results);
  const gates = evaluateGates(report.metrics, options.gates);
  // A harness-level fault (missing fixture, dead provider) is not something the
  // gates can see, and it must not be reportable as a pass.
  const gateResult: GateResult =
    errors.length === 0
      ? gates
      : { passed: false, failures: [...gates.failures, ...errors] };
  const passed = gateResult.passed;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: options.mode,
          model,
          gates: options.gates,
          metrics: report.metrics,
          gateResult,
          cases: report.rows,
          errors,
          passed,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${formatReport(report, gateResult, { mode: options.mode, model }, options.gates)}\n`,
    );
    for (const error of errors) process.stderr.write(`eval: ${error}\n`);
  }

  return passed ? 0 : 1;
}

// No top-level await: this file is run by `tsx` from the repo root, which has no
// "type": "module", so it is transformed to CJS.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `eval: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
