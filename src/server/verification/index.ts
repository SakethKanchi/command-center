export type {
  AtsDimension,
  AtsScoreBreakdownEntry,
  AtsScoreInput,
  AtsScoreReport,
} from "./ats-score";
export {
  ATS_WEIGHTS,
  DEFAULT_ATS_THRESHOLD,
  extractHeadingCandidates,
  hasPhoneNumber,
  normalizeFontName,
  scoreAtsCompliance,
  scoreAtsComplianceForPdf,
} from "./ats-score";
export type {
  FactGateInput,
  FactGateReport,
  FactGateViolation,
  FactGateViolationKind,
} from "./fact-gate";
export {
  DEFAULT_FORBIDDEN_PHRASES,
  foldDigits,
  normalizeClaim,
  stripMarkup,
  verifyDocumentFacts,
} from "./fact-gate";
export type { PdfText } from "./pdf-text";
export { extractPdfText, PdfTextExtractionError } from "./pdf-text";
