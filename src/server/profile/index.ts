/**
 * Public face of the profile module, for the HTTP layer.
 *
 * Importing this pulls `./import`, and with it pdfjs. Modules that only need
 * the draft mapping or the completeness rules — the repository, the resume
 * pipeline, the migration script — import those files directly rather than
 * loading a PDF parser they never call.
 */

export { profileCompleteness } from "./completeness";
export type { ExtractedProfileDraft } from "./extract";
export {
  deterministicDraft,
  draftFromResumeText,
  PROFILE_EXTRACTION_SCHEMA,
} from "./extract";
export type { ExtractedResumeText, ResumeFile } from "./import";
export {
  extractResumeText,
  MAX_RESUME_IMPORT_BYTES,
  MAX_RESUME_IMPORT_MB,
  SUPPORTED_RESUME_EXTENSIONS,
} from "./import";
export { draftToProfile, profileToDraft } from "./map";
export { ensureProfileSchema } from "./schema";
