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
only for a company token the user names, and are skipped with that reason
rather than firing a request that cannot succeed. The six are deliberately not
interchangeable: two take the keyword upstream, Himalayas is the largest remote
index, Arbeitnow is the only continental-Europe feed, and The Muse is the only
one that publishes office and hybrid roles at all. A board with no search
parameter is paged and filtered locally, and the run reports which of the two
happened rather than leaving "8 results" ambiguous.

Downstream, a Google Sheet and a Notion workspace hold four lanes —
Opportunities, Applications, Interviews, Follow-ups — rendered from one
canonical snapshot, so the two destinations cannot disagree with each other or
with the database.

## The app: six routes, all state in the URL

| Route | What it is for |
|---|---|
| `/` | **Search** — free text, eleven filter groups, and board discovery |
| `/profile` | **Profile** — the candidate record, plus resume import |
| `/pipeline` | **Pipeline** — opportunities, applications, interviews, follow-ups |
| `/runs`, `/runs/:runId` | **Runs** — every agent run, step by step, deep-linkable |
| `/apps` | **Apps** — connect Gmail, Google Sheets and Notion |
| `/settings` | **Settings** — the model to call, and the thresholds that stop a run |

Every filter, tab and selection lives in the URL, so a result set is a thing
you can bookmark, share and walk back through with the browser's back button.
`/runs` and `/runs/:runId` are one screen with and without a selection rather
than two components.

Audited in a real Chromium session across all six: one `h1` per page, 0
overflowing elements, 0 clipped buttons, 0 unlabeled inputs, 0 console errors.

Search facts worth naming, because they are where correctness is easy to fake:
experience matches by **overlap**, not containment, so a posting wanting 3-6
years answers a 5-10 year search. Skills, levels and eligibility are namespaced
tags (`skill:python`, `level:senior`) extracted from the posting's own words at
write time, deterministically and offline — a filter rail has to be exact on
every row the moment it lands, and it must not cost a model call. Tags OR within
a kind and AND across kinds: measured on the seeded corpus, `skill:python`
returns 16 and adding `level:senior` narrows it to 11. Places are matched on
normalized segments and travel as repeated query keys, never comma-separated —
a place contains its own comma, and splitting on it turned one city into
`["Toronto","Canada"]`, at which point every city returned the same rows.
`null` is never treated as zero: an unscored posting sorts last rather than as
0, and a posting that published no salary is excluded while a pay floor is set
rather than assumed to clear or fail it. There is no FTS5 — it is a
compile-time option the SQLite inside `node:sqlite` cannot be relied on to
have — so free text is a `LIKE` scan over one prepared lowercase column.

## Why the plan is fixed, not model-chosen

The model decides *content*: the score, the tailored copy, the email text. It
does not decide *control flow*. `AGENT_TOOLS` is a closed union of eleven tools
and an unknown tool name fails the run rather than being improvised.

That buys three things a free-form loop does not have: the failure modes are
enumerable, every run is comparable to every other run, and the trace is
auditable step by step. For a system that emails recruiters on someone's behalf,
those matter more than flexibility.

## Connecting three apps without three OAuth projects

Each of Gmail, Sheets and Notion has a direct client — Google OAuth, a Notion
integration token — and direct credentials always win when they exist. Composio
is the path for a user who has neither, and it is where most of the integration
work went, because **Composio issues two credential classes and they are not
interchangeable**:

| | project key | user key |
|---|---|---|
| prefix | `ck_` / `ak_` | `uak_` |
| headers | `x-api-key` | `x-user-api-key` + `x-org-id` + `x-project-id` |
| execute | `POST /tools/execute/{slug}` | open a tool-router session, execute inside it |

Both classes are supported, because supporting only one excludes real users. A
**consumer** project — what `composio login` gives an individual — issues *only*
the user key, so a client that knows just `x-api-key` cannot connect that
account at all. Conversely a team project key cannot address a consumer entity.

Resolution order is `COMPOSIO_API_KEY` in the environment, then the CLI's own
credential file at `${COMPOSIO_CACHE_DIR:-~/.composio}/user_data.json`. The
environment wins because it is the deliberate per-deployment choice; the CLI
file is read rather than asked for because it is already on disk after
`composio login`, and hand-copying a secret into `.env` is how secrets end up
in git. Every failure to read that file is a fallback, never a throw: a user who
never installed the CLI is the normal case, not an error.

Four details the user-key path forced, each of which cost a live debugging
round:

- **`x-project-id` is not optional.** Without it, `GET /connected_accounts`
  answers HTTP 200 with an **empty list** rather than an error — a forgotten
  header reads as "you have no connected apps" instead of as a bug. Headers are
  therefore built in exactly one function, which is what makes that
  unforgettable. The project and entity come from one
  `POST /api/v3/org/consumer/project/resolve` (v3, not v3.1), cached per key
  for the life of the process; the in-flight promise is cached rather than the
  value, so concurrent callers share one resolve instead of racing.
- **A tool-router session is opened once and reused.** Opening one per call
  would add a round trip to every step of a ten-step run. On
  `ToolRouterV2_SessionNotFound` the cache entry is dropped and the session is
  reopened **once** — a second miss is a real failure, and retrying forever
  would hide it behind a loop.
- **Bind the ACTIVE account, not the first one.** Selection was
  `find(ACTIVE) ?? accounts[0]`. This user's Composio holds four connected
  accounts — `notion ACTIVE`, `notion FAILED`, `gmail ACTIVE`,
  `gmail EXPIRED` — so first-match bound the corpse and reported a connected
  app that could not execute a single tool. Only ACTIVE accounts are bound now;
  a toolkit whose best account is anything else is reported as needing a
  reconnect. The hosted consent flow polls an account that is `INITIATED`, so
  `ACTIVE`, then `INITIATED` is the poll order — an ACTIVE-only rule would
  stall a link that is legitimately still open.
- **`successful: false` arrives with HTTP 200.** The client never treats a 2xx
  as success on its own. Composio's own error wording is surfaced verbatim
  (`APIKey_InvalidAPIKey`, plus `suggested_fix` when present), so a
  misconfigured key reads "Invalid API key" rather than "upstream failed".

### Typed Notion rows, one column definition

Composio's `properties` for a database row is a **flat** `[{name,type,value}]`
list; Notion's REST API wants its own nested payload. Two renderers for the same
four lanes is two chances to drift, so both derive from a single column
definition per lane: the schema Notion is provisioned with, the nested payload,
and Composio's flat list all come off the same table, and every limit Notion
enforces (2000-char rich text, 100-char select names, date normalization) is
applied once before either renderer sees the value.

Verified live, end to end: the app created a lane database under the user's own
"Job & Internship Tracker" page, inserted one opportunity row, then read the row
back out of Notion and confirmed **15 of 15 columns** with the right types —
`Score` the number 88, `Remote` the checkbox true, `Source` the select
`greenhouse`, `Date Posted` a date, `Job URL` a url, every rich_text field
intact.

Google Sheets runs over the same transport: one tab per lane, written one A1
range per call so a failing lane cannot take the other three down with it.

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
  archived — and revoking the Composio account leaves the workspace untouched.

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

### 5. The process starts and stops predictably

A demo runs on a laptop; a judge may run it under a process manager. Both get
the same guarantees, all of them cheap:

- **Configuration is validated once, at boot,** by a zod schema over the
  environment. A `PORT` that is not a number exits 1 naming the variable and
  the reason, rather than listening on `NaN`. The parsed config is frozen, and
  a blank assignment is read as absent rather than as an empty value.
- **Migrations apply on start** and are idempotent, so a fresh volume and an
  older database both reach the schema the code expects. A database it cannot
  use is a startup failure that says which file.
- **A missing optional credential is still a soft degrade.** No LLM key means
  every other surface works and the agent says so when a step needs the model;
  it is announced once at boot instead of surprising the operator on the first
  step.
- **Host binding follows the environment.** `NODE_ENV=production` binds
  `0.0.0.0` because a container has to publish to be reachable; anything else
  binds `127.0.0.1`, because an unauthenticated single-user app does not belong
  on the local network by default. `HOST` overrides either.
- **SIGTERM drains.** Stop accepting, finish in-flight requests, reconcile,
  close SQLite, exit 0 — in that order, and the order is the point. Reconciling
  before the drain would fail a run that is about to finish normally; closing
  the database first would make an in-flight request throw on a closed handle.
  Sockets still open at the deadline are cut and the exit code stays 0.
- **An interrupted run never reads as "still working".** The agent writes
  `running` on create and a terminal status on every exit path; a process killed
  between the two leaves the row stranded. Runs left mid-step are reconciled
  both on the way down for signals we can handle and on the way up for the ones
  we cannot (SIGKILL, OOM, power).
- **Production error bodies carry no stack traces.** Under
  `NODE_ENV=production` an unexpected error returns its code and nothing else;
  the real text — file paths, SQL fragments, upstream wording — goes to the log.

### 6. Evaluation: 20 real postings, offline, free

```
label agreement           : 90% (18/20)   gate >= 80%
score within tolerance    : 90% (18/20)   gate >= 80%
mean |delta score|        : 3.30 over 20/20 scored
unusable observations     : 0/20
latency p50/p95           : n/a (replay makes no calls)

PASS — every gate met
```

Cases are built from real postings, not invented fixtures. Replay mode reads
recorded model output, so `npm run eval` makes no network calls, needs no API
key, and costs nothing — it belongs in CI. It exits non-zero when a gate fails;
an empty or all-errored result set fails closed rather than reporting a vacuous
pass. Genuine disagreements survive in the set, so the metric is not
self-fulfilling.

### 7. Tests

```
605 tests, 39 files          tsc --noEmit: 0 errors
                             biome check: clean over 248 files
```

37.0k lines of source, 16.0k lines of test. The covered surface is the whole
app, not the easy half: the Composio client and both credential paths, the
Sheets, Notion and Gmail transports, the connector snapshot and sync ledger,
all nine board adapters and their normalizers, search and its filters and
places, the ATS scorer and the fabrication gate, the agent plan, resume import
and extraction, every API route, the repositories, settings resolution, the
eval metrics, the process lifecycle, and the six web screens.

Every outbound client takes `fetchImpl: typeof fetch` by injection and no
adapter calls global `fetch`. That one rule is why the whole external surface —
Sheets, Notion, Gmail, Composio, nine job boards, the LLM — is covered without a
single network call. Each board's fixture is a trimmed real response, one
unusable row included, so the drop rules are exercised against what the wire
actually sends. The resume test is the exception that proves the rule: it
renders a **real PDF** and feeds it to the real ATS scorer, asserting >= 90.

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
different dates on two machines. Composio expiries arrive as an ISO string or as
epoch seconds or millis, and all three funnel through one normalizer.

**Single user.** No ownership columns. Adding multi-user scoping later is one
migration; threading an unused owner id through every query costs clarity on
every read.

## What is verified live, and what is not

Verified live means a real call to the real service from this machine with the
response read back; documented only means built to the vendor's published
contract and covered by offline tests, but never yet executed against the live
service.

| Surface | Status |
|---|---|
| Six keyless job boards | **Verified live** — real postings ingested |
| LLM scoring, tailoring, outreach drafting | **Verified live** |
| Resume render + ATS scorer + fabrication gate | **Verified live** — real PDF, ATS 94/100 |
| Composio credential resolution, both classes | **Verified live** — `user from cli`, 4 connected accounts listed |
| Composio tool-router session + execute | **Verified live** — `NOTION_WHO_AM_I`, `GMAIL_GET_PROFILE` |
| Notion over Composio: create database, insert row | **Verified live** — 15/15 columns read back |
| Notion over the direct REST client | Documented only — needs an integration token |
| Google Sheets over Composio | Documented only — tool slugs and argument names from the toolkit reference, toolkit version 20260902_00 |
| Google Sheets + Gmail over direct OAuth | Documented only — needs a Google Cloud project |
| Gmail **send** | Documented only — the account is ACTIVE and its profile reads back, but no message has been sent |

## Honest limits

- **Gmail send needs a credential this build does not provide itself.** Either
  Composio's hosted Gmail consent or a Google Cloud project of your own. The
  Composio Gmail account here is ACTIVE and its profile reads back live, so the
  transport is proven; the send itself is untested against a real mailbox and is
  reported as such.
- The three per-company ATS boards (Greenhouse, Ashby, Lever) need a board
  token. Without one they are skipped with that reason stated per source.
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
  lane is populated manually. Gmail is wired for *sending* only, and the consent
  asks for no read scope it does not use.
- `npm run connect composio` diagnoses `COMPOSIO_API_KEY` only. A CLI login is
  read by the server, not by that script.

## Attribution

Portions of the ATS scorer, the fabrication gate, the evaluation harness design,
the job-board clients and the scoring rubric derive from
[career-ops](https://github.com/santifer/career-ops), MIT licensed. Details in
[NOTICE](NOTICE).
