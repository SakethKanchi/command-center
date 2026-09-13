# Two-minute demo script

Timings are cumulative. Everything below has been run end to end; nothing is
staged for the camera.

## Before you record

```bash
npm install
npm run migrate
npm run seed                  # real postings from a keyless aggregator

cp .env.example .env          # set LLM_API_KEY — a funded key, see below
npm run connect google        # Sheets + Gmail send, one consent
npm run connect notion        # integration token + parent page
npm run connect status        # expect three ✓

npm run dev                   # API :8787, dashboard :5173
```

Open `http://localhost:5173`.

Two things to settle first:

1. **Use a funded LLM key.** A rate-limited free model will stall mid-run or
   miss the outreach JSON schema, which turns the best 20 seconds of the demo
   into a spinner.
2. **Rehearse on one specific posting.** Run the agent once in `dry_run` on the
   row you plan to click. If the fabrication gate halts it, you have a choice:
   pick a different row, or keep it and demo the halt on purpose — the halt is
   the stronger story. Decide before you hit record.

## 0:00–0:15 — The problem, on screen

Land on the dashboard. The four tiles are already populated from real ingested
postings.

> "These are real job postings, pulled from live boards. The problem was never
> finding them — it's that every application is forty minutes of tailoring,
> emailing, and spreadsheet bookkeeping spread across four different apps."

Point at the three connector cards — Sheets, Notion, Gmail — all connected.

## 0:15–0:35 — Fire the agent

Opportunities tab → your chosen row → **Apply For Me**.

> "One agent, one posting. Ten steps across five external systems. Watch the
> trace."

The trace fills in live. Call out the app badge on each row as it lands — LLM,
Local, Gmail, Sheets, Notion. That badge column is the multi-app story; let the
judges read it.

## 0:35–1:05 — The gate is the point

Stop on step 4, `verify_resume`.

> "Before anything leaves this machine, two deterministic checks. ATS
> parseability, scored out of a hundred against eight weighted dimensions. And
> a fabrication gate that pulls every numeric claim out of the generated copy
> and checks it against my actual profile."

If the run halted here:

> "This run stopped. The model wrote a claim my profile doesn't support, so the
> agent refused to send it. That's the whole design — it would rather do
> nothing than lie to a recruiter."

If it passed, say that in one line and move on. Do not linger.

## 1:05–1:25 — Human in the loop, then the fan-out

Step 6 is parked on `awaiting_approval` with the full draft visible.

> "It will not send unattended. Here is the exact message it wants to send. I
> approve it —"

Click **Approve and send**.

> "— and the same application lands in Gmail's sent folder, a Google Sheet, and
> a Notion database, rendered from one snapshot so the three can't disagree."

Have the Sheet open in one tab and Notion in another. Same rows, four lanes
each.

## 1:25–1:45 — Idempotency, live

Press **Sync all apps** twice.

> "Second sync: zero writes. Every row is content-hashed, so re-running is a
> no-op instead of duplicating your pipeline. Same guarantee on the agent — a
> retried run reuses its recorded result instead of emailing twice."

Every row reports `unchanged`.

## 1:45–2:00 — How we know it works

Terminal:

```bash
npm run eval
```

> "Golden cases built from real postings, graded against reference labels, with
> hard gates. It runs offline from recorded output, so it's free and
> deterministic in CI — and it fails the build when quality regresses."

Last thing on screen: the `PASS` line.

## If something breaks mid-take

| Symptom | Cause | Fix |
|---|---|---|
| Agent errors on a credit/402 | LLM key exhausted | new key in `.env`, restart |
| `Not configured` on a push step | connector missing | `npm run connect status` |
| Render step fails | typst missing | `typst --version`, then reinstall |
| Empty dashboard | nothing ingested | `npm run seed` |

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
