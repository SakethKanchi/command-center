# Command Center — system and reliability brief

Submission for the Multi-App AI Agent Hackathon, 13 September 2026.

## What it does

One agent, **Apply-For-Me**, runs a fixed ten-step plan for a single job
posting and touches five external systems on the way:

| # | Step | External system |
|---|---|---|
| 1 | `score_job` | LLM |
| 2 | `tailor_resume` | LLM |
| 3 | `render_resume_pdf` | local (Typst) |
| 4 | `verify_resume` | local — **hard gate** |
| 5 | `draft_outreach_email` | LLM |
| 6 | `send_outreach_email` | **Gmail** — approval required |
| 7 | `record_application` | local |
| 8 | `push_sheets` | **Google Sheets** |
| 9 | `push_notion` | **Notion** |
| 10 | `schedule_follow_up` | local |

Steps 5 and 6 run only when there is somebody to write to. A recipient has
exactly two sources: the address the posting states, parsed out of its prose at
write time, or one the user typed and confirmed in the drawer — which always
wins and survives re-ingest. Guessing `first.last@company.com` from a company
domain is a deliberate non-goal: a fabricated recipient is the same failure
class the resume fact gate exists to stop, aimed at a stranger's inbox. Search
rows say `HR CONTACT` when an address exists and stay silent when none does,
so the badge never claims reach the app does not have.

Upstream, nine job-board adapters supply the opportunity feed. Six work from a
keyword alone — freehire, Remotive, Jobicy, Himalayas, The Muse and Arbeitnow —
and three are per-company ATS boards (Greenhouse, Ashby, Lever) that answer
only for a company token the user names. The six are deliberately not
interchangeable: two take the keyword upstream, Himalayas is the largest remote
index, Arbeitnow is the only continental-Europe feed, and The Muse is the only
one that publishes office and hybrid roles at all. A board with no search
parameter is paged and filtered locally, and the run reports which of the two
happened rather than leaving "8 results" ambiguous.

Downstream, a Google Sheet and a Notion workspace hold four lanes —
Opportunities, Applications, Interviews, Follow-ups — rendered from one
canonical snapshot, so the two destinations cannot disagree with each other or
with the database.

## Why the plan is fixed, not model-chosen

The model decides *content*: the score, the tailored copy, the email text. It
does not decide *control flow*. `AGENT_TOOLS` is a closed union of eleven tools
and an unknown tool name fails the run rather than being improvised.

That buys three things a free-form loop does not have: the failure modes are
enumerable, every run is comparable to every other run, and the trace is
auditable step by step. For a system that emails recruiters on someone's behalf,
those matter more than flexibility.

## Reliability

### 1. Two gates, and the agent obeys them

**The fit gate (step 1b).** Scoring is worthless if the plan ignores the answer.
A score below 20 — the floor of the rubric's "weak" band, meaning a hard
disqualifier — stops the run before any tailoring happens. This was added after
watching a real run score a posting **10/100 with "missing required Java
experience"** and then spend three more model calls tailoring a resume for it.
The score is a model judgement rather than a fact, so `force: true` lets the
user overrule it; the default does not.

**The verification gate (step 4).** Two deterministic checks on the rendered
PDF:

- **ATS parseability** — 0–100 across eight weighted dimensions (text 15,
  sections 20, contact 15, layout 20, images 10, fonts 10, charset 5, hidden 5).
  Below 70 the plan halts.
- **Fabrication** — every numeric and metric claim in the generated copy is
  checked against the candidate profile. An unsupported claim halts the plan.

Observed on a real run: ATS **94/100**, 0 unsupported claims. The two findings
that cost points are honest ones — no phone number on the profile (deliberate,
see below) and one missing optional section.

Violations are split by severity, which is the second thing a real run taught
us. The gate originally halted on *any* violation, which blocked a verified
application over the filler phrase "passionate about". Now an unsupported claim
halts the run and a forbidden filler phrase is reported and the run continues.
The gate exists to stop lies reaching recruiters, not to enforce prose taste at
the cost of the pipeline.

### 2. Nothing irreversible happens unattended

- Runs default to `mode: "dry_run"`. An omitted mode never means live.
- In live mode, `send_outreach_email` does not send. It writes an
  `awaiting_approval` step carrying the exact payload and stops. Sending happens
  only on an explicit decision, recorded with who made it.
- `disconnect` never deletes user data — no sheet rows dropped, no Notion pages
  archived.

### 3. Replay cannot duplicate an effect

Every step may carry an idempotency key derived from the tool plus its semantic
payload — never a timestamp or a run id. Before executing, the runner looks for
a prior *succeeded* step under the same key and reuses its recorded output. A
partial unique index enforces it at the storage layer:

```sql
CREATE UNIQUE INDEX idx_agent_steps_idempotency
  ON agent_steps(tool, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'succeeded';
```

The connector layer gets the same property by a different route: every pushed
row is hashed (sha256 over key-sorted JSON) and the digest stored in
`connector_records`. Re-pushing unchanged data issues **zero** HTTP writes and
reports `unchanged`. The Sheets test asserts zero value reads *and* zero value
writes in that case.

The hash comparator is pinned to UTF-16 code-unit ordering rather than
`localeCompare`: locale collation depends on ICU data, so the same row could
otherwise hash differently on two machines and break the ledger permanently.

### 4. Partial failure degrades, it does not cascade

- A row that fails a push lands in `report.failures`; its siblings still land.
- A sync run where some rows wrote is `completed` with `recordsFailed > 0`.
  `failed` is reserved for a run that achieved nothing.
- An unconfigured destination is **skipped with a reason**, not an error.
  Verified: with no Google or Notion credentials, a real run completed steps
  1–5 and 7–10 and reported `push_sheets: Not configured`,
  `push_notion: Not configured`.
- One failing job board never aborts the others; its error is recorded per
  source and the healthy boards still persist.
- Retries cover 429 and 5xx only, bounded at 3 attempts, honouring
  `Retry-After` as a floor with full jitter. A 400 is never retried —
  re-issuing a request that may already have had an effect is worse than
  surfacing the error.

### 5. Evaluation: 20 real postings, offline, free

```
label agreement           : 90% (18/20)   gate >= 80%
score within tolerance    : 90% (18/20)   gate >= 80%
mean |delta score|        : 3.30 over 20/20 scored
unusable observations     : 0/20
PASS — every gate met
```

Cases are built from real postings, not invented fixtures. Replay mode reads
recorded model output, so `npm run eval` makes no network calls, needs no API
key, and costs nothing — it belongs in CI. It exits non-zero when a gate fails;
an empty or all-errored result set fails closed rather than reporting a vacuous
pass. Three genuine disagreements survive in the set, so the metric is not
self-fulfilling.

### 6. Tests

```
37 files, 571 tests, 7.6s
```

| Area | Tests |
|---|---|
| Connectors (Composio 38, Sheets 26, Notion 19, Gmail send 18, snapshot 9) | 110 |
| Web UI | 85 |
| Search, filters and places | 75 |
| Verification (ATS 32, fabrication 34) | 66 |
| Ingest adapters + normalizers | 47 |
| API routes | 40 |
| Profile import + extraction | 34 |
| Eval metrics | 33 |
| Repositories | 24 |
| Agent plan | 20 |
| LLM client + prompts | 14 |
| Resume render | 13 |
| Settings | 10 |

33.2k lines of source, 15.0k lines of test.

Every outbound client takes `fetchImpl: typeof fetch` by injection and no
adapter calls global `fetch`. That one rule is why the whole external surface —
Sheets, Notion, Gmail, nine job boards, the LLM — is covered without a single
network call. Each board's fixture is a trimmed real response, one unusable row
included, so the drop rules are exercised against what the wire actually sends.
The resume test is the exception that proves the rule: it renders a **real PDF**
and feeds it to the real ATS scorer, asserting >= 90.

Assertions were spot-checked by mutation rather than assumed. Flipping one bot
click to human in the engagement test turns it red (`expected 4 to be 3`);
changing the base64 line length and a header name turns exactly the two relevant
Gmail tests red; moving `MAX_CONCURRENT_SOURCES` off 5 fails the concurrency
bound.

## Engineering choices worth naming

**No native modules.** Storage is `node:sqlite`, built into Node. Nothing to
compile, no prebuild to match a local ABI, so the usual install failure mode
does not exist.

**No epoch timestamps.** Every timestamp column is `TEXT` holding ISO-8601 UTC,
and so is every value crossing the API. A mixed seconds/millis schema is the
most common source of silent off-by-1000 date bugs; this one cannot express it.
A board that publishes a zoneless date-time — Remotive sends
`2026-09-11T20:16:48` — is read as UTC rather than as host-local time, which
`Date.parse` would otherwise do, so one recorded payload cannot produce two
different dates on two machines.

**Single user.** No ownership columns. Adding multi-user scoping later is one
migration; threading an unused owner id through every query costs clarity on
every read.

## Honest limits

- **Sheets, Notion and Gmail send are verified against stubs, not yet against
  live APIs.** They need OAuth credentials this machine does not have.
  `npm run connect google` and `npm run connect notion` provision them in one
  consent each; until then those three connectors report `Not configured` and
  the agent skips them. Everything upstream of them is exercised live.
- The LLM key available during the build was an exhausted key, so runs used a
  free model. It handled scoring and tailoring correctly but failed the outreach
  JSON schema after 2 attempts on one run. The client already negotiates three
  response modes; a funded model removes the remaining failure.
- **The agent does not submit ATS forms.** It scores, tailors, renders,
  verifies, records, syncs and sends outreach. Auto-submitting third-party
  application forms is a deliberate non-goal.
- The committed profile omits a phone number, which costs 5 ATS points
  (94 rather than 99). Publishing a phone number in a public repo is the worse
  trade.
- Interviews arrive by reading a mailbox, which this build does not do; that
  lane is populated manually. Gmail is wired for *sending* only, and the OAuth
  consent asks for no read scope it does not use.

## Attribution

Portions of the ATS scorer, the fabrication gate, the evaluation harness design,
the job-board clients and the scoring rubric derive from
[career-ops](https://github.com/santifer/career-ops), MIT licensed. Details in
[NOTICE](NOTICE).
