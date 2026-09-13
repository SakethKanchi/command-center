import type { AgentApp, ConnectorProvider } from "@domain";

/**
 * How each external system presents itself. `AgentApp` is the closed union the
 * agent stamps on every step, so this table is exhaustive by construction and
 * the trace can never render an unlabelled badge.
 *
 * The colours live in `styles.css` keyed by `data-app`; only the wording is
 * here. Keeping them apart means a chip, a rail node and a duration bar always
 * agree on the hue without any of them passing a colour around.
 */
export type AppPresentation = {
  /** Short enough to read on a projector, specific enough to be unambiguous. */
  label: string;
  /** What the agent actually does there, for the systems legend tooltip. */
  role: string;
};

export const APP_PRESENTATION: Record<AgentApp, AppPresentation> = {
  local: { label: "Local", role: "This machine: render, verify, record" },
  job_boards: { label: "Job boards", role: "Greenhouse, Lever and friends" },
  llm: { label: "LLM", role: "Scoring, tailoring and drafting" },
  gmail: { label: "Gmail", role: "Outreach send" },
  google_sheets: { label: "Sheets", role: "The four-tab command center" },
  notion: { label: "Notion", role: "Opportunity database" },
};

/**
 * Connector presentation. `setupHint` names the exact command that fixes an
 * unconfigured connector, so the calm "not set up" state is actionable rather
 * than merely reassuring. The server overrides it whenever it knows which
 * credential is missing; the direct-transport health payload carries no hint
 * at all, so this stays the fallback for a provider whose own OAuth token has
 * gone stale.
 *
 * `consentNote` and `retentionNote` are the two sentences a user needs before
 * and after granting access. They are per-provider because "nothing is
 * deleted" means a different concrete thing for a spreadsheet, a database and
 * a mailbox, and a generic reassurance is the kind a user does not believe.
 */
export const PROVIDER_PRESENTATION: Record<
  ConnectorProvider,
  {
    label: string;
    app: AgentApp;
    purpose: string;
    setupHint: string;
    consentNote: string;
    retentionNote: string;
  }
> = {
  google_sheets: {
    label: "Google Sheets",
    app: "google_sheets",
    purpose: "Four tabs: opportunities, applications, interviews, follow-ups",
    setupHint: "Run: npm run connect google",
    consentNote:
      "Grants permission to create and update one spreadsheet. Nothing else in your Drive is read.",
    retentionNote:
      "Command Center stops writing rows. The spreadsheet and every row already in it stay exactly as they are.",
  },
  notion: {
    label: "Notion",
    app: "notion",
    purpose: "Opportunity database, one page per role",
    setupHint: "Run: npm run connect notion",
    consentNote:
      "You pick the pages to share on Notion's own screen. Only what you pick is visible.",
    retentionNote:
      "Command Center stops writing pages. Every page already in your database stays.",
  },
  gmail_send: {
    label: "Gmail",
    app: "gmail",
    purpose: "Sends outreach and follow-up mail as you",
    setupHint: "Run: npm run connect google",
    consentNote:
      "Grants send-only access. Every outbound message still waits for your approval in the run trace.",
    retentionNote:
      "Command Center stops sending mail. Messages already sent stay in your Sent folder.",
  },
};

/** Display order: rows first, then the app that sends mail about them. */
export const PROVIDER_ORDER: ConnectorProvider[] = [
  "google_sheets",
  "notion",
  "gmail_send",
];
