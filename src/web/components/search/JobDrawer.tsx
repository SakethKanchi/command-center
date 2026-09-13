import {
  JOB_TAG_KIND_LABELS,
  JOB_TAG_KINDS,
  type JobCard,
  type JobTag,
  parseJobTag,
  tagLabel,
} from "@domain";
import { DeepLink } from "@web/components/ui";
import {
  formatRelative,
  formatYearsRange,
  titleWithoutCompany,
} from "@web/lib/format";
import { Loader2, Mail, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The full posting, without leaving the result set.
 *
 * Focus is trapped while it is open and Escape closes it, because a drawer a
 * keyboard user can tab out of but not see is worse than no drawer: the tab
 * order silently leaves the dialog and lands on rows hidden behind it.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function JobDrawer({
  job,
  applying,
  applyDisabled,
  contactSaving,
  onClose,
  onApply,
  onSaveContact,
}: {
  job: JobCard;
  applying: boolean;
  applyDisabled: boolean;
  contactSaving: boolean;
  onClose: () => void;
  onApply: (job: JobCard) => void;
  /** `null` clears the override and restores whatever the posting states. */
  onSaveContact: (job: JobCard, email: string | null) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [recipient, setRecipient] = useState(job.contactEmail ?? "");

  // A save answers with the stored row, so the field follows the server rather
  // than keeping the text the user typed: clearing an override reveals the
  // posting's address again, and the input has to show that.
  useEffect(() => {
    setRecipient(job.contactEmail ?? "");
  }, [job.contactEmail]);

  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>('[data-drawer-autofocus="true"]')
      ?.focus();
  }, []);

  // On the document rather than the panel so Escape still works after a click
  // on a non-focusable part of the drawer has dropped focus to the body.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const title = titleWithoutCompany(job.title, job.company);
  const hasYears =
    job.experienceMinYears !== null || job.experienceMaxYears !== null;

  const facts: Array<[string, string]> = [
    ["Company", job.company],
    ["Location", job.location ?? "Not stated"],
    [
      "Remote",
      job.isRemote === null ? "Not stated" : job.isRemote ? "Yes" : "No",
    ],
    [
      "Experience",
      hasYears
        ? formatYearsRange(job.experienceMinYears, job.experienceMaxYears)
        : "Not stated",
    ],
    ["Salary", job.salaryText ?? "Not stated"],
    ["Fit score", job.score === null ? "unscored" : `${job.score} / 100`],
    ["Source", job.source],
    [
      "Posted",
      job.postedAt
        ? formatRelative(job.postedAt)
        : `found ${formatRelative(job.discoveredAt)}`,
    ],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Dismissing by clicking away is a pointer affordance; the keyboard path
          is Escape and the close button, so this carries no role. */}
      <div
        className="absolute inset-0 bg-deck/70"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} at ${job.company}`}
        className="relative flex h-full w-full max-w-[560px] flex-col border-l border-ridge-hi bg-panel shadow-2xl"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;

          const nodes = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
          );
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (!first || !last) return;

          const active = document.activeElement;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b border-ridge px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] leading-snug font-medium text-ink">
              {title}
            </h2>
            <p className="u-mono mt-1 truncate text-ink-dim">{job.company}</p>
          </div>
          <button
            type="button"
            data-drawer-autofocus="true"
            aria-label="Close posting"
            className="btn shrink-0"
            onClick={onClose}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>

        {/* Contained so flicking through a long description does not scroll the
            result list underneath once the drawer hits its end. */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="u-meta text-ink-faint">{label}</dt>
                <dd className="truncate text-[13px] text-ink-dim">{value}</dd>
              </div>
            ))}
          </dl>

          {job.brief ? (
            <section className="mt-5 border-t border-ridge pt-4">
              <h3 className="u-meta text-signal">Model brief</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
                {job.brief.roleSummary}
              </p>
              <BriefList label="Must have" items={job.brief.mustHaves} />
              <BriefList label="Nice to have" items={job.brief.niceToHaves} />
              <BriefList label="Red flags" items={job.brief.redFlags} alarm />
              {job.scoreReason ? (
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-faint">
                  {job.scoreReason}
                </p>
              ) : null}
            </section>
          ) : null}
          <TagGroups tags={job.tags} />

          {/*
           * Outreach is the one step in the plan whose input cannot be
           * derived: an address either came from the posting or from the user.
           * Editable in both cases, because the parser's pick is a candidate
           * and the mail goes out under the user's name.
           */}
          <section className="mt-5 border-t border-ridge pt-4">
            <h3 className="u-meta text-signal">Outreach recipient</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">
              {job.contactEmailSource === "manual"
                ? "Confirmed by you. Outreach will be drafted to this address."
                : job.contactEmailSource === "posting"
                  ? "Read from the posting. Check it before a live run sends."
                  : "The posting names no address, so a run skips outreach entirely. Add one to enable it."}
            </p>
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveContact(job, recipient.trim() || null);
              }}
            >
              <label className="sr-only" htmlFor="job-contact-email">
                Outreach recipient email
              </label>
              <input
                id="job-contact-email"
                type="email"
                value={recipient}
                placeholder="hiring@company.com"
                autoComplete="off"
                className="h-9 min-w-0 flex-1 rounded-sm border border-ridge-hi bg-panel px-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none"
                onChange={(event) => setRecipient(event.target.value)}
              />
              <button
                type="submit"
                className="btn shrink-0"
                disabled={
                  contactSaving || recipient.trim() === (job.contactEmail ?? "")
                }
              >
                {contactSaving ? (
                  <Loader2 className="spin size-3.5" aria-hidden />
                ) : (
                  <Mail className="size-3.5" aria-hidden />
                )}
                Save
              </button>
            </form>
          </section>

          <section className="mt-5 border-t border-ridge pt-4">
            <h3 className="u-meta text-ink-faint">Posting</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-dim">
              {job.descriptionText}
            </p>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ridge px-5 py-3.5">
          <DeepLink href={job.applyUrl ?? job.url}>Open posting</DeepLink>
          <button
            type="button"
            className="btn btn-primary"
            disabled={applyDisabled}
            aria-label={`Apply for me: ${title} at ${job.company}`}
            onClick={() => onApply(job)}
          >
            {applying ? (
              <Loader2 className="spin size-3.5" aria-hidden />
            ) : (
              <Zap className="size-3.5" aria-hidden />
            )}
            {applying ? "Working…" : "Apply for me"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefList({
  label,
  items,
  alarm,
}: {
  label: string;
  items: string[];
  alarm?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className={`u-meta ${alarm ? "text-alarm" : "text-ink-faint"}`}>
        {label}
      </h4>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="text-[13px] text-ink-dim">
            · {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * All tags on the posting, grouped by kind in the vocabulary's canonical
 * order so the drawer reads like the taxonomy, not like insertion order.
 */
function TagGroups({ tags }: { tags: JobTag[] }) {
  if (tags.length === 0) return null;
  const labelsByKind: Partial<
    Record<(typeof JOB_TAG_KINDS)[number], string[]>
  > = {};
  for (const tag of tags) {
    const parsed = parseJobTag(tag);
    if (!parsed) continue;
    // The slug is storage, not prose: `scikit_learn` and `full_time` are not
    // spellings anyone should have to read out of a drawer.
    const label = tagLabel(parsed.tag);
    const group = labelsByKind[parsed.kind];
    if (group) group.push(label);
    else labelsByKind[parsed.kind] = [label];
  }
  return (
    <section className="mt-5 border-t border-ridge pt-4">
      <h3 className="u-meta text-signal">Tags</h3>
      {JOB_TAG_KINDS.map((kind) => {
        const labels = labelsByKind[kind];
        if (!labels || labels.length === 0) return null;
        return (
          <div key={kind} className="mt-3">
            <h4 className="u-meta text-ink-faint">
              {JOB_TAG_KIND_LABELS[kind]}
            </h4>
            <ul className="mt-1 space-y-0.5">
              {labels.map((label) => (
                <li key={label} className="text-[13px] text-ink-dim">
                  · {label}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
