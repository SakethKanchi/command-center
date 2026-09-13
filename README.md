# Command Center

An AI agent that carries a job posting from discovery to a tracked application
across Gmail, Google Sheets and Notion — and refuses to send work that fails an
automated quality gate.

Built for the [Multi-App AI Agent Hackathon](https://multiappagenthackathon.com/).

## Demo

https://github.com/SakethKanchi/command-center/raw/main/docs/demo.mp4

![Command Center demo](docs/demo.gif)

Forty-three seconds, recorded against the running app: live postings, the
profile, the pipeline, a run that halts on a named step, a dry run that
completes, three connected apps, and the thresholds that stop a run.
([download the MP4](docs/demo.mp4))

- **[SYSTEM_BRIEF.md](SYSTEM_BRIEF.md)** — architecture, reliability design, limits
- **[DEMO.md](DEMO.md)** — two-minute demo script
- **[evals/README.md](evals/README.md)** — the evaluation harness
- **[NOTICE](NOTICE)** — third-party attribution

## The agent

`Apply-For-Me` runs a fixed ten-step plan for one posting:

```
 1  score_job             LLM
 2  tailor_resume         LLM
 3  render_resume_pdf     local (Typst)
 4  verify_resume         local        ← HARD GATE
 5  draft_outreach_email  LLM
 6  send_outreach_email   Gmail        ← approval required
 7  record_application    local
 8  push_sheets           Google Sheets
 9  push_notion           Notion
10  schedule_follow_up    local
```

The model decides *content* — the score, the tailored copy, the email text. It
does not decide *control flow*: `AGENT_TOOLS` is a closed union, and an unknown
tool name fails the run instead of being improvised. That trade makes the
failure modes enumerable and every run comparable to every other run, which
matters more than flexibility for a system that emails recruiters on your
behalf.

Three properties make it safe to point at a real mailbox:

1. **Step 4 is a gate, not a report.** An ATS parseability score below 70, or
   any claim the candidate profile does not support, halts the plan before
   anything leaves the machine.
2. **Sending is never unattended.** Runs default to `dry_run`. A live run parks
   the send with its exact payload and waits for a named decision.
3. **Replay cannot duplicate an effect.** Steps carry idempotency keys enforced
   by a partial unique index; pushed rows are content-hashed, so a re-sync is a
   no-op rather than a duplicate.

## The app

Six screens, one per job the tool actually does:

| Route | What it is for |
|---|---|
| `/` | **Search** — free text, filters, and discovery against the live boards |
| `/profile` | **Profile** — the editable candidate record, plus resume import |
| `/pipeline` | **Pipeline** — opportunities, applications, interviews, follow-ups |
| `/runs` | **Runs** — every agent run, step by step, deep-linkable |
| `/apps` | **Apps** — connect Gmail, Google Sheets and Notion |
| `/settings` | **Settings** — the model to call, and the thresholds that stop a run |

Every filter, tab, and selection lives in the URL, so a result set is a thing
you can bookmark, share, and walk back through with the browser's back button.

### Search

Two different actions that are easy to confuse:

- **Filter** narrows the postings already in the database.
- **Discover** (`POST /api/discover`) goes and asks the boards for new ones.

Nine boards are wired. Six answer a keyword on their own — freehire, Remotive,
Jobicy, Himalayas, The Muse and Arbeitnow — and are what a discovery uses by
default. Three are per-company ATS boards (Greenhouse, Ashby, Lever) that need
the company's board token and are skipped, with that reason, when none is given.

The six are not redundant: freehire and Jobicy take the keyword upstream,
Himalayas is the largest remote index, Arbeitnow is the only continental-Europe
feed, and The Muse is the only one carrying office and hybrid roles. Three of
them publish no search parameter at all, so the keyword and the place are
applied locally over a bounded page walk — and the per-source report says which
filters the board honoured and which this app had to carry itself, because "10
results" means different things in those two cases.

Filters: free text, place, experience range, level, skills, employment type,
eligibility, fit score, posted-within, source, status, and a pay floor.

Experience matches by **overlap**, not containment — a posting wanting 3-6 years
answers a 5-10 year search. Skills, levels and eligibility are namespaced tags
(`skill:python`, `level:senior`) extracted from the posting's own words at write
time, deterministically and offline: a filter rail has to be exact on every row
the moment it lands, and it must not cost a model call. Tags OR within a kind
and AND across kinds, so two skills widen the set and a skill plus a level
narrows it. Measured on the seeded corpus: `skill:python` 16, adding
`level:senior` 11.

Places are matched on normalized segments rather than raw substrings, because
the real data holds `Toronto, Canada`, `Toronto, Ontario` and `Toronto - Bay St`
for one city, and both `Québec` and `Quebec`. Several places are sent as
repeated query keys, never comma-separated — a place contains its own comma, and
splitting on it turned one city into `["Toronto","Canada"]`, at which point
"Canada" matched the entire corpus and every city returned the same rows.

`null` is never treated as zero. An unscored posting is *not yet judged*, so it
sorts last rather than as 0; a posting that published no salary is dropped while
a pay floor is set rather than being assumed to clear or fail it.

A saved resume also gets **suggested roles**: a row of titles the profile
already clears, each one a one-click search. They cost a model call, so they
are generated once and stored against a fingerprint of the profile fields they
were drawn from — editing a bullet regenerates them, correcting a phone number
does not. A machine with no saved resume shows no row at all rather than
suggesting roles off the committed seed profile.

## Run it in a container

One image: the API, the built dashboard, and the Typst binary the resume
renderer shells out to. Docker and Podman both work — swap `docker` for
`podman` in every command below.

```bash
cp .env.example .env     # optional: LLM_API_KEY enables live agent runs
docker compose up --build
```

Open `http://localhost:8787` — the server serves the dashboard and the API on
the same port, so there is no second dev port in this mode.

Podman without compose:

```bash
podman build -t command-center .
podman volume create command-center-data
podman run --rm -p 8787:8787 \
  -v command-center-data:/data \
  --env-file .env \
  command-center
```

Notes:

- Migrations run on boot and are idempotent, so a fresh volume works.
- The SQLite file holds connector credentials and the LLM key, so it lives on
  the `/data` volume, never in the image.
- Seed the corpus with real postings once the container is up:
  `docker compose exec command-center npm run seed`
  (`podman exec -it <container> npm run seed`).
- Connect the external apps the same way:
  `docker compose exec command-center npm run connect google`.
- `PUBLIC_BASE_URL` must be reachable by whoever opens a tracked resume link —
  set it to the tunnel host when demoing to a real recipient.

## Quick start without a container

```bash
npm install
npm run migrate
npm run seed            # ingest real postings from all six keyless boards

cp .env.example .env    # add LLM_API_KEY for live agent runs
npm run dev             # API on :8787, dashboard on :5173
```

Open `http://localhost:5173`.

The evaluation harness needs no credentials at all:

```bash
npm run eval
```

### Run it in production

```bash
npm run build            # dashboard into dist/web
NODE_ENV=production npm start
```

One process then serves the API and the dashboard on `PORT`. Production binds
`0.0.0.0`, because a container has to publish to be reachable; anything else
binds `127.0.0.1`, and `HOST` overrides either. It also defaults logs to JSON
and keeps stack traces out of API error bodies.

The environment is validated once at boot, so a bad `PORT` exits 1 naming the
variable and the reason rather than failing later, one route at a time.
Migrations apply on start. `SIGTERM` stops accepting, drains the in-flight
requests, marks any run interrupted mid-step as failed with that reason, closes
SQLite and exits 0 — `SHUTDOWN_TIMEOUT_MS` bounds the drain, 10s by default.

### Connect the external apps

Two routes, and direct wins when both are available.

```bash
npm run connect google   # Google Sheets + Gmail send, one OAuth consent
npm run connect notion   # integration token + parent page
npm run connect composio # check COMPOSIO_API_KEY against Composio, explain a rejection
npm run connect status
```

Direct credentials take precedence whenever they exist — a broker in front of
everything would collapse three integrations into one, and the direct clients
are already built and tested. Each connector reports which transport it is on.

The other route is Composio, which hosts the OAuth app: Gmail, Notion and
Sheets each connect with one consent, no Google Cloud project and no Notion
integration secret. Composio issues two kinds of credential, and this app takes
either one.

| | project key | user key |
|---|---|---|
| prefix | `ck_` / `ak_` | `uak_` |
| comes from | [platform.composio.dev](https://platform.composio.dev) → Settings → API Keys | `composio login` |
| app reads it from | `COMPOSIO_API_KEY` in the environment | `${COMPOSIO_CACHE_DIR:-~/.composio}/user_data.json` |
| headers | `x-api-key` | `x-user-api-key` + `x-org-id` + `x-project-id` |
| executes a tool via | `POST /tools/execute/{slug}` | a tool-router session, opened once and reused |

`composio login` is the zero-copy option: the CLI already wrote the key to
disk, the server reads it from there, and no secret has to go into `.env`. It is
also the *only* option for a **consumer** project — an individual login — which
issues nothing but the user key. `COMPOSIO_API_KEY` wins when both are present.

If you do paste a project key, copy the whole thing: the dashboard shows keys
masked, and a truncated paste is rejected with `APIKey_InvalidAPIKey`.
`npm run connect composio` tells you which of the two happened — it reports set
or unset, the length, a masked head and tail, then calls Composio and prints the
verdict in Composio's own words. It diagnoses the environment variable only; a
CLI login is read by the server, not by that script. The free tier covers this
app comfortably.

Then press **Connect** on `/apps` and consent in the window that opens. Only an
`ACTIVE` account is ever bound, so a stale `FAILED` or `EXPIRED` account sitting
beside a working one cannot be mistaken for a live connection; a card that is
not green names what to reconnect.

An unconfigured connector is skipped with a reason, so the agent runs without
them. Disconnecting never deletes anything in the external app.

### The candidate profile

Edit it at `/profile`, or import an existing resume (`.pdf`, `.docx`, `.txt`,
`.md`) and review the parsed draft before it is saved. Import **never**
autosaves: it returns a draft, you accept it, and only then is anything written.

It holds identity, a summary, links, skills, experience, projects and
education. Projects are the section with no employer attached — side projects,
open source, coursework — and their bullets are quoted and reordered per
posting exactly as a role's are.

The profile is the single source of truth every fabrication check reads, which
is also why the importer will not guess at it. An extracted name that looks like
an organisation or a section heading is refused rather than accepted — a wrong
name here is a wrong name on a resume sent to a recruiter — and an email or
phone number that does not appear verbatim in the uploaded file is dropped with
a warning.

A stored profile wins; `src/server/resume/profile.json` is the seed a fresh
clone falls back to. The committed copy deliberately omits a phone number: that
costs 5 points on the ATS contact dimension (94/100 rather than 99), which is a
fair price for not publishing a phone number in a public repo.

## Verify

```bash
npm run typecheck        # tsc --noEmit
npm run test             # 605 tests across 39 files
npm run lint             # biome
npm run eval             # exits non-zero when a quality gate fails
npm run verify           # typecheck, test, eval
```

## Design notes

**No native modules.** Storage is `node:sqlite`, built into Node 22.5+. There
is nothing to compile, no prebuild to match against a local ABI, and therefore
none of the usual install failures.

**No epoch timestamps.** Every timestamp column is `TEXT` holding ISO-8601 UTC,
and so is every value crossing the API. Mixed seconds/millis columns are the
most common source of silent off-by-1000 date bugs, so the schema simply cannot
express one.

**No global `fetch` in an adapter.** Every outbound client takes
`fetchImpl: typeof fetch` by injection. That single rule is why the entire
external surface — Sheets, Notion, Gmail, nine job boards, the LLM — is covered
by tests that make zero network calls.

**Single user.** No ownership columns anywhere. Adding multi-user scoping later
is one migration; threading an unused owner id through every query costs
clarity on every read.

**No FTS5.** It is a compile-time option, and the SQLite inside `node:sqlite`
cannot be relied on to have it. Free text is a `LIKE` scan over one prepared
lowercase column, which is correct at this data size; there is no index on it,
because a B-tree cannot serve `%term%` and pretending otherwise is cargo cult.

**Derived columns, written once.** The experience window, the annualized
salary, the tags and the search text are computed at write time in a single
mapping chokepoint rather than recomputed per query — a pay floor has to be a
SQL predicate, and no expression over `"$180k - $220k"` can compare itself to a
number.

## Layout

```
src/domain/              shared types: jobs, search, tags, profile, connectors, agent
src/server/
  db/                    schema.sql + node:sqlite access
  infra/                 validated config, errors, logger, retry policy, lifecycle
  repos/                 all data access
  llm/                   OpenAI-compatible client, scoring, tailoring
  ingest/                nine job-board adapters, six of them keyless
  search/                free text, filters, experience, salary, tags, places
  profile/               resume import (PDF/DOCX), structured extraction
  resume/                profile, three Typst templates, PDF render, tracked links
  verification/          ATS score + fabrication gate
  settings/              effective config: stored setting, else env, else default
  connectors/            Sheets, Notion, Gmail send, Composio, snapshot, sync
  agent/                 the ten-step plan, step runner, outreach drafting
  api/                   Hono app + routers (jobs, discover, profile, settings)
src/web/                 React app: search, profile, pipeline, runs, apps, settings
evals/                   golden set, replay fixtures, runner, gates
scripts/                 connect (OAuth setup + Composio key doctor), seed, backfill
```

## Attribution

Portions of the ATS scorer, the fabrication gate, the evaluation harness
design, and the job-board clients derive from
[career-ops](https://github.com/santifer/career-ops) (MIT). Full details in
[NOTICE](NOTICE).
