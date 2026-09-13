# Golden-set eval for LLM scoring and resume tailoring

A labelled golden set plus a runner that measures how closely this repo's two
LLM-backed capabilities reproduce a frozen reference verdict. The default mode
replays recorded model output, so a run makes **zero network calls, spends zero
dollars, and is bit-for-bit deterministic** — it is safe to make a required CI
check.

Ported from `career-ops/eval-golden.mjs` (labelled cases, replay/live split,
hard gate on agreement-with-reference).

## What is evaluated

| Lane | Subject under evaluation |
|------|--------------------------|
| `scoring` | `scoreJob` + `JOB_SCORING_SCHEMA` in `src/server/llm/score-job.ts` — a 0-100 fit score plus a reason |
| `tailoring` | `tailorResume` + `RESUME_TAILORING_SCHEMA` in `src/server/llm/tailor-resume.ts` — headline, summary, skill keywords |

The metric is **agreement-with-reference, not absolute correctness**. Each case
carries a frozen reference verdict; the harness measures distance from it. That
is the measure that matters in practice: it catches a prompt edit, a model
swap, or a provider regression that quietly moves the product's judgement.

## Where the cases came from

All 20 cases are built from **real job postings**, ingested by a job-board
pipeline from the boards this project reads — not from invented job
descriptions. Each case records the job id it came from in `source.jobId`, and
the posting text is the stored description with markdown escapes and HTML
stripped; nothing was rewritten, trimmed, or paraphrased. The cases span the
full range the scorer sees in practice, from an entry-level RAG engineering
role down to plumbing design and sales management.

Listing the scored rows in a local database for review:

```bash
node --input-type=module -e '
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const db = new DatabaseSync("data/command-center.db", { readOnly: true });
console.log(db.prepare("SELECT id,title,company,location,score,score_reason FROM jobs ORDER BY score DESC").all());
'
```

The candidate profile embedded in every case (`input.candidate`) is a frozen,
compact summary of the same candidate whose tailored resume rows produced the
fixtures: ~2 years of experience, Python/TypeScript/React/RAG, NYC metro, plus
the gaps that decide most of these postings (no clearance, no graduate degree,
limited Java, no mainframe or GPU-systems background). It carries no name,
contact details, or credentials, and no API key appears anywhere in `evals/`.

### The two expectation shapes

- **Scoring** — `expected.label` is the categorical band (`strong` >= 65,
  `moderate` >= 40, `weak` >= 20, `reject` < 20) and `expected.score` is the
  reference score with a `tolerance` band. The band label is the gating signal
  because it is a clean 0/1 comparison; the raw score is graded inside a
  tolerance band, exactly as upstream did.
- **Tailoring** — `expected.requiredKeywords` are terms from that posting that
  must survive into the tailored output, and `expected.forbiddenFabrications`
  are claims the candidate cannot support and that must never appear (a
  clearance, a Master's or PhD, an inflated tenure, a stack they do not have).
  The observed score is required-keyword coverage as a percentage, so it shares
  the 0-100 scale; the observed label is `faithful`, `thin` (coverage below
  75%), or `fabricated` — any forbidden claim makes the case `fabricated`
  regardless of coverage, because an invented credential is worse than a thin
  summary.

### Provenance: labels vs fixtures

These are deliberately two different things, which is what keeps the eval from
being self-fulfilling:

- `evals/cases/*.json` → `expected` is `reference-graded-v1`: a reference-tier
  grading of the posting against the frozen candidate profile, band first,
  using the hard filters the posting states (required years, required stack,
  location and remote policy, clearance, degree). `notes` records the reasoning
  for each case.
- `evals/fixtures/*.json` → `output` is the **recorded output of a real run**
  of this pipeline, read out of `jobs.score` / `jobs.score_reason` and
  `jobs.tailored_headline` / `tailored_summary` / `tailored_skills`. The job
  row carries no model id, so the fixture records
  `model: "recorded-production-run"` rather than claiming a model it cannot
  prove. `--live --update-fixtures` re-records them with the real model id and
  a timestamp.

Because the reference verdict and the recorded run are independent, the set
contains genuine disagreements — three of them today, all visible in the report
below. That is the point: a golden set where everything trivially passes
measures nothing.

## Running

```bash
npx tsx evals/run.ts --replay                       # offline, deterministic, $0 (default)
npx tsx evals/run.ts --replay --json                 # machine-readable, for CI
npx tsx evals/run.ts --case scoring-atc-ai-engineer-genai
npx tsx evals/run.ts --live                          # calls the configured provider
npx tsx evals/run.ts --live --update-fixtures        # re-record fixtures from real output
npx tsx evals/run.ts --replay --gate-label 0.95      # tighten a gate to see a FAIL
```

Exit code is `0` only when every gate passes **and** every case produced an
observation. A missing replay fixture is a hard failure, not a skipped case.
`--update-fixtures` refuses to run without `--live`, so a replay run can never
overwrite the recorded outputs it is supposed to be checking against.

Replay reads nothing but `evals/cases/` and `evals/fixtures/`: no provider call,
no `process.env` credential read. Every credential-shaped line lives behind the
`--live` branch (`LLM_API_KEY`, `LLM_BASE_URL`, `MODEL` — the same variables the
server reads). Live calls get a 15s timeout and at most 3 attempts with
jittered backoff that honours `Retry-After`, retrying only 429 and 5xx.

Unit tests for the metric math:

```bash
npx vitest run evals/scoring.test.ts
```

## Gates

| Gate | Value | Where |
|------|-------|-------|
| Label agreement | >= 0.8 | `MIN_LABEL_AGREEMENT` in `evals/scoring.ts` |
| Score within tolerance | >= 0.8 | `MIN_WITHIN_TOLERANCE` in `evals/scoring.ts` |
| Scoring tolerance band | +/-10 on 0-100 | `DEFAULT_SCORE_TOLERANCE` |
| Tailoring coverage tolerance | +/-25 points of coverage | `DEFAULT_COVERAGE_TOLERANCE` |

`0.8` is ported straight from upstream's `MIN_ARCHETYPE_AGREEMENT`; the
tolerance band is upstream's `SCORE_TOLERANCE = 0.5` on a 1-5 rubric (12.5% of
that scale) mapped onto this repo's 0-100 scale. Upstream reported mean
|delta score| as a secondary signal only — we promote the tolerance hit-rate to
a second gate, because a model can hide individual blowouts behind a low mean
and a hit-rate cannot be gamed that way. Mean |delta score| is still printed.

Denominators are always the full case count. A case with a missing fixture, an
unusable completion, or a non-numeric score stays in the denominator and counts
as a miss on both axes, and an empty or fully-unusable run fails closed rather
than reporting a vacuous 100%.

## What a failure means

- **Label agreement dropped** — the product's verdict moved across a band
  boundary on real postings: a `reject` became `moderate`, or a `strong` match
  stopped looking strong. Users would see reordered pipelines.
- **Score-within-tolerance dropped** while labels held — the ranking is drifting
  inside bands. Usually a prompt or temperature change.
- **A tailoring case turned `fabricated`** — the tailored resume claimed
  something the profile does not support. This is the one failure to treat as
  release-blocking on its own.
- **A tailoring case turned `thin`** — the tailored output stopped reflecting
  the posting's own vocabulary, which is what gets a resume filtered out.
- **`missing replay fixture`** — a case was added without recording an output.
  Run `--live --update-fixtures`.

## Layout

```
evals/
  cases/         20 labelled golden cases, one JSON per case
  fixtures/      recorded model output, one JSON per case, for $0 replay
  run.ts         the runner (flags above); all I/O lives here
  scoring.ts     metric math + gates, pure functions
  scoring.test.ts  vitest coverage of the metric math and the gate boundaries
```

## Current replay output

```
golden-set eval — 20 case(s), mode=replay, model=recorded-production-run

  case                                        kind      expected        observed          delta  res
  ---------------------------------------------------------------------------------------------  ---
  scoring-beaconfire-jr-ai-engineer           scoring   strong 80       strong 78           2.0  ok 
  scoring-precisely-associate-python-ai       scoring   strong 74       strong 72           2.0  ok 
  scoring-homedepot-sr-swe-ai-innovation      scoring   moderate 64     strong 75          11.0  MISS
                                              ^ label miss (reference moderate); score outside +/-10; The candidate's core expertise in RAG and AI workflows aligns perfectly with the
  scoring-atc-ai-engineer-genai               scoring   moderate 60     strong 68           8.0  MISS
                                              ^ label miss (reference moderate); Strong skills overlap in Python, RAG, vector stores, FastAPI, LangChain, and LLM
  scoring-microsoft-software-engineer-ii      scoring   moderate 58     moderate 62         4.0  ok 
  scoring-ithaka-senior-cloud-infrastructure  scoring   moderate 50     moderate 55         5.0  ok 
  scoring-matrix-software-solutions-developer scoring   moderate 42     moderate 48         6.0  ok 
  scoring-saic-data-scientist-associate       scoring   moderate 40     moderate 42         2.0  ok 
  scoring-wordware-senior-ai-frontend         scoring   weak 30         weak 38             8.0  ok 
  scoring-stripe-specialist-sa-crypto         scoring   weak 22         weak 35            13.0  MISS
                                              ^ score outside +/-10; The candidate significantly lacks the required 7+ years of professional experien
  scoring-ust-agentic-ai-multi-agent          scoring   reject 18       reject 18           0.0  ok 
  scoring-ensono-senior-swe-mainframe         scoring   reject 8        reject 10           2.0  ok 
  scoring-michaelbaker-piping-designer        scoring   reject 5        reject 3            2.0  ok 
  scoring-twilio-senior-manager-sales         scoring   reject 4        reject 3            1.0  ok 
  tailoring-atc-ai-engineer-genai             tailoring faithful 100    faithful 100        0.0  ok 
  tailoring-harris-associate-ai-assisted-deve~tailoring faithful 100    faithful 100        0.0  ok 
  tailoring-microsoft-software-engineer-ii    tailoring faithful 100    faithful 100        0.0  ok 
  tailoring-precisely-associate-python-ai     tailoring faithful 100    faithful 100        0.0  ok 
  tailoring-rainfocus-full-stack-developer    tailoring faithful 100    faithful 100        0.0  ok 
  tailoring-saic-data-scientist-associate     tailoring faithful 100    faithful 100        0.0  ok 

  label agreement           : 90% (18/20)   gate >= 80%
  score within tolerance    : 90% (18/20)   gate >= 80%
  mean |delta score|        : 3.30 over 20/20 scored
  unusable observations     : 0/20
  latency p50/p95           : n/a (replay makes no calls)

  PASS — every gate met
```

The three misses are real and stay in the set:

- `scoring-homedepot-sr-swe-ai-innovation` and `scoring-atc-ai-engineer-genai` —
  the production run rewarded stack overlap and under-weighted hard filters
  (5+ years preferred; 3+ years plus a required Master's plus onsite Texas),
  pushing both into `strong` where the reference grades them `moderate`.
- `scoring-stripe-specialist-sa-crypto` — a 7+ year technical-sales req scored
  35 against a reference of 22. Same band, but 13 points outside the tolerance.

Both patterns point at the same fix: weight stated hard filters above keyword
overlap in the scoring prompt. That is the kind of finding this harness exists
to produce.
