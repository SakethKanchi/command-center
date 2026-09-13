/**
 * Job search: the query, plus the schema reconciliation it depends on.
 *
 * The jobs repository imports `./fields` and `./schema` directly rather than
 * through this file. Those two are leaves by design — the repository has to
 * write the derived columns without importing the query layer that reads them.
 */

export { searchJobs } from "./jobs-search";
export {
  listKnownLocations,
  matchesLocation,
  normalizeLocation,
} from "./location";
export { ensureJobSearchSchema } from "./schema";
