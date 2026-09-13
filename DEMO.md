# Two-minute demo script

Beats are wall-clock and cumulative; they sum to 120 seconds. Every step below
is performable against the current app — nothing here is staged, and nothing
that has not been run live appears in the script.

## Before you record

```bash
npm install
npm run migrate
npm run seed                  # real postings from the six keyless boards

cp .env.example .env          # set LLM_API_KEY — a funded key, see below
composio login                # user key, read straight from ~/.composio
npm run connect status        # see which transport each app is on

npm run dev                   # API :8787, dashboard :5173
```

Open `http://localhost:5173`.

Four things to settle first:

1. **Use a funded LLM key.** A rate-limited free model stalls mid-run, which
   turns the best 30 seconds of the demo into a spinner.
2. **Have at least one app connected and green on `/apps`.** Either
   `composio login` (no key copied anywhere) or `COMPOSIO_API_KEY` in `.env`;
   direct OAuth also works and wins when both exist.
3. **Rehearse on one specific posting.** Run the agent once in `dry_run` on the
   row you plan to click and time it. If the verification gate halts it, you
   have a choice: pick a different row, or keep it and demo the halt on purpose
   — the halt is the stronger story. Decide before you hit record.
4. **Have a resume file on the desktop** (`.pdf`, `.docx`, `.txt` or `.md`) for
   the import beat.

Order matters in one place: the filter beat quotes result counts from the seeded
corpus, and discovery adds rows. Filter first, discover second.

## 0:00–0:10 — Real data, not a fixture

Land on `/`. The result list is already full of postings ingested from live
boards.

> "Real postings, pulled from live job boards. Finding them was never the
> problem — every application after that is forty minutes of tailoring,
> emailing and spreadsheet bookkeeping across four apps."

## 0:10–0:30 — Filtering is exact, and it is in the URL

In the filter rail, tick **python** under *Skills*: the count drops to 16. Tick
**senior** under *Level*: 11.

> "Skills and levels are namespaced tags, pulled out of each posting's own words
> when it lands — deterministic, offline, no model call. Two skills widen the
> set; a skill plus a level narrows it. Sixteen to eleven."

Point at the address bar.

> "Every filter is in the URL. This result set is a link I can send you, and the
> back button walks it backwards."

## 0:30–0:48 — Discovery, live against the boards

Press **Board search**, type a keyword, run it.

> "That was filtering rows I already had. This goes and asks the boards."

Let the per-source report land.

> "Per source, because any one board can fail on its own. It also says which
> filters the board honoured and which the app had to apply itself — ten results
> means two different things in those two cases, and collapsing that into one
> number is a lie in both directions. The three per-company ATS boards are
> skipped, and they say why: they need a board token I have not given them."

## 0:48–1:05 — The profile is the source of truth

Go to `/profile`. Under **Import a resume**, drop the file on the zone or use
*choose a file*.

> "The fabrication gate needs something to check against, so the profile is the
> single source of truth — which is exactly why the importer refuses to guess.
> An email or phone number that does not appear verbatim in the file is dropped
> with a warning, and an extracted name that looks like a company is refused."

The parsed draft appears for review. Discard it.

> "And an import is never an autosave. It arrives as a draft, I accept it, and
> only the save button writes anything."

## 1:05–1:35 — One run, and the gate is the point

Back to `/`, your rehearsed row, **Apply for me**. The trace streams into
`/runs`.

> "One agent, one posting. A fixed ten-step plan across five external systems.
> The model picks the score and the copy; it does not pick the steps — the tool
> list is a closed union, so an invented tool name fails the run instead of
> improvising."

Call out the app badge on each row as it lands — LLM, Local. Then stop on step
4, `verify_resume`.

> "Before anything leaves this machine: ATS parseability out of a hundred across
> eight weighted dimensions, and a fabrication check that pulls every numeric
> claim out of the generated copy and tests it against my profile. Below seventy,
> or one unsupported claim, and the plan halts here."

If it halted:

> "This run stopped. The model wrote a claim my profile doesn't support, so the
> agent refused to carry it further. That is the whole design — it would rather
> do nothing than lie to a recruiter."

If it passed, say so in one line — "94 out of 100, zero unsupported claims" —
and move on. Do not linger.

> "And the send step is never unattended. In live mode it parks the exact
> payload and waits for a named decision."

## 1:35–1:50 — Three apps, no OAuth project

Go to `/apps`. The connected card is green.

> "Gmail, Sheets and Notion each have a direct client, and direct credentials
> win when you have them. I don't — so this connected on a hosted consent link:
> no Google Cloud project, no client secret anywhere in this repo."

> "Composio issues two kinds of credential. A team project key goes in the
> environment. A personal login issues only a user key, which needs different
> headers and a tool-router session to execute anything at all. This app
> supports both, and it read the one already on this machine from the CLI login
> — so no secret was copied into a dotfile. Notion rows land fully typed:
> number, checkbox, select, date, url."

## 1:50–2:00 — How we know it works

Terminal:

```bash
npm run eval
```

> "Twenty golden cases built from real postings, graded against reference
> labels, with hard gates. It replays recorded model output, so it is free,
> offline and deterministic in CI — and it fails the build when quality
> regresses. Six hundred and five tests behind it, and not one of them makes a
> network call, because every outbound client takes its `fetch` by injection."

Last thing on screen: the `PASS — every gate met` line.

## If something drags mid-take

| Symptom | Cause | Fix |
|---|---|---|
| Run is slower than 30s | model latency | fire **Apply for me** at the end of the discovery beat and narrate the profile while it works |
| Agent errors on a credit/402 | LLM key exhausted | new key in `.env` or on `/settings`, no restart needed |
| `Not configured` on a push step | no transport for that app | `npm run connect status` |
| Card on `/apps` is not green | account is FAILED or EXPIRED | press Connect again; only an ACTIVE account is ever bound |
| Render step fails | typst missing | `typst --version`, then reinstall |
| Empty result list | nothing ingested | `npm run seed` |
| Counts are not 16 and 11 | discovery already ran | quote the counts on screen instead |

## One-command fallback

If the UI misbehaves, the whole story still runs from a terminal:

```bash
npm run eval                  # reliability evidence, offline

curl -s localhost:8787/api/agent/apply \
  -H 'content-type: application/json' \
  -d '{"jobId":"<id>","mode":"dry_run","contactEmail":"you@example.com"}' | jq
```

The second command prints the full step trace as JSON — every tool, the app it
touched, its duration, attempt count, and the gate verdict.
