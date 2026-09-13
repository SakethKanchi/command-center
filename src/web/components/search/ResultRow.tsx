import { type JobCard, tagLabel } from "@domain";
import { Meter } from "@web/components/ui";
import {
  formatRelative,
  formatYearsRange,
  titleWithoutCompany,
  truncate,
} from "@web/lib/format";
import { Loader2, Zap } from "lucide-react";

/**
 * One posting as a flight strip: identity on the left, the numbers that decide
 * whether to act on the right.
 *
 * Real postings carry 200-character titles and company names with legal
 * suffixes attached, so every text cell is a `min-w-0` flex child with
 * `truncate` — the row height is fixed by design and never negotiated by the
 * content.
 */
export function ResultRow({
  job,
  applying,
  applyDisabled,
  onOpen,
  onApply,
}: {
  job: JobCard;
  applying: boolean;
  applyDisabled: boolean;
  /** The trigger is handed back so focus can return to this exact row. */
  onOpen: (job: JobCard, trigger: HTMLElement) => void;
  onApply: (job: JobCard) => void;
}) {
  const title = titleWithoutCompany(job.title, job.company);
  const hasYears =
    job.experienceMinYears !== null || job.experienceMaxYears !== null;
  const meta = [
    hasYears
      ? formatYearsRange(job.experienceMinYears, job.experienceMaxYears)
      : null,
    job.source,
    job.postedAt
      ? `posted ${formatRelative(job.postedAt)}`
      : `found ${formatRelative(job.discoveredAt)}`,
  ].filter((part): part is string => part !== null);

  return (
    <li
      data-testid={`result-${job.id}`}
      className="lane-row flex items-center gap-4 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block w-full truncate text-left text-[14.5px] font-medium text-ink hover:text-signal focus:outline-1 focus:outline-signal"
          onClick={(event) => onOpen(job, event.currentTarget)}
        >
          {title}
        </button>

        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[13px] text-ink-dim">
          <span className="min-w-0 shrink truncate">{job.company}</span>
          {job.location ? (
            <span className="min-w-0 shrink truncate text-ink-faint">
              {job.location}
            </span>
          ) : null}
          {job.isRemote === null ? null : (
            <span
              className={`u-mono shrink-0 rounded-xs border px-1 py-px text-[10.5px] tracking-wider uppercase ${
                job.isRemote
                  ? "border-pass/40 text-pass"
                  : "border-ridge-hi text-ink-faint"
              }`}
            >
              {job.isRemote ? "remote" : "on-site"}
            </span>
          )}
          {/*
           * Shown only when an address actually exists. The absent case is
           * deliberately silent rather than a "no contact" chip: every row
           * without one would carry it, and a badge that fires on the
           * majority stops being read.
           */}
          {job.contactEmail ? (
            <span
              className="u-mono shrink-0 rounded-xs border border-signal/40 px-1 py-px text-[10.5px] tracking-wider uppercase text-signal"
              title={`Outreach can be sent to ${job.contactEmail}`}
            >
              hr contact
            </span>
          ) : null}
          {job.salaryText ? (
            <span className="u-mono shrink-0 text-[11.5px] text-ink-dim">
              {truncate(job.salaryText, 28)}
            </span>
          ) : null}
          {job.tags.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1">
              {job.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  // Lowercased in CSS rather than in the label, so the drawer
                  // can still spell them "TypeScript" and "C#": the strip's
                  // metadata line is uniformly lowercase mono next to the
                  // `remote` / `on-site` badge, and one capitalised chip in
                  // that run reads as a different kind of thing.
                  className="u-mono shrink-0 rounded-xs border border-ridge-hi px-1 py-px text-[10.5px] tracking-wider lowercase text-ink-faint"
                >
                  {tagLabel(tag)}
                </span>
              ))}
              {job.tags.length > 4 ? (
                <span className="u-mono shrink-0 text-[10.5px] text-ink-faint">
                  +{job.tags.length - 4}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-3">
          {job.score === null ? (
            <span className="u-mono text-[11.5px] text-ink-faint">
              unscored
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <span className="u-numeral text-[17px] text-ink">
                {job.score}
              </span>
              <Meter value={job.score} />
            </span>
          )}
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
        <span className="u-mono text-[11.5px] text-ink-faint">
          {meta.join(" · ")}
        </span>
      </div>
    </li>
  );
}
