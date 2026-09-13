/**
 * Populate the database with real job postings.
 *
 * Deliberately only ingests real postings. Applications, interviews and
 * follow-ups are NOT fabricated here: those rows are supposed to be produced by
 * actually running the agent, and seeding fake ones would make the dashboard
 * lie about what the system did.
 *
 *   npm run seed                       # every keyless board, 60 postings each
 *   npm run seed -- --limit 25
 *   npm run seed -- --source greenhouse:stripe --source lever:netflix
 *   npm run seed -- --query "ai engineer"
 */
import { getDb } from "@server/db";
import { toAppError } from "@server/infra/errors";
import {
  type IngestSource,
  ingestJobs,
  listSourceAdapters,
} from "@server/ingest/registry";
import { createRepos } from "@server/repos";

function parseArgs(argv: string[]): { sources: IngestSource[]; limit: number } {
  const sources: IngestSource[] = [];
  let limit = 60;
  let query: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag === "--limit") {
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--limit expects a positive integer, got ${value}`);
      }
      limit = parsed;
      i += 1;
      continue;
    }

    if (flag === "--query") {
      if (!value) throw new Error("--query expects a search string");
      query = value;
      i += 1;
      continue;
    }

    if (flag === "--source") {
      if (!value) throw new Error("--source expects <id> or <id>:<board>");
      const [id, board] = value.split(":", 2);
      if (!id) throw new Error(`Could not read a source id from "${value}"`);
      sources.push(board ? { id, board } : { id });
      i += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${flag}`);
  }

  // Every source that works without a company board token, which is what a
  // fresh clone can reach with no configuration. All six, not one: a corpus
  // from a single board gives the search rail a single opinion about which
  // places, employers and pay bands exist.
  const resolved =
    sources.length > 0
      ? sources
      : listSourceAdapters()
          .filter((adapter) => !adapter.needsBoardToken)
          .map((adapter) => ({ id: adapter.id }));
  return {
    sources: query ? resolved.map((s) => ({ ...s, query })) : resolved,
    limit,
  };
}

async function main() {
  const { sources, limit } = parseArgs(process.argv.slice(2));
  const repos = createRepos(getDb());

  console.log(
    `Ingesting up to ${limit} posting(s) from: ${sources
      .map((s) => (s.board ? `${s.id}:${s.board}` : s.id))
      .join(", ")}`,
  );

  const result = await ingestJobs({ sources, limit, repos });

  for (const source of result.bySource) {
    // A skip is not a failure: the board was never asked, because nobody named
    // a company for it.
    const status = source.skipped
      ? `skipped — ${source.error}`
      : source.error
        ? `failed — ${source.error}`
        : `${source.fetched} fetched`;
    console.log(`  ${source.id.padEnd(14)} ${status}`);
    for (const note of source.notes ?? [])
      console.log(`  ${" ".repeat(14)} ${note}`);
  }

  const counts = repos.jobs.counts();
  console.log(
    `\n${result.inserted} inserted, ${result.updated} updated. Database now holds:`,
  );
  for (const [status, count] of Object.entries(counts)) {
    if (count > 0) console.log(`  ${status.padEnd(12)} ${count}`);
  }

  if (result.inserted + result.updated === 0) {
    const asked = result.bySource.filter((source) => !source.skipped);
    console.log(
      asked.length === 0
        ? "\nNothing was ingested. Every source was skipped — pass a board, e.g. `greenhouse:stripe`."
        : "\nNothing was ingested. Every source failed — check the errors above.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const appError = toAppError(error);
  console.error(`\nSeed failed (${appError.code}): ${appError.message}`);
  process.exit(1);
});
