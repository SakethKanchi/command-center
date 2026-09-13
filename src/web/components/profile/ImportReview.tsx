import type { ProfileDraft } from "@domain";
import { formatCount } from "@web/components/ui";
import type { ResumeImportResponse, ReviewPath } from "@web/lib/profile";
import { applyReview, reviewRows } from "@web/lib/profile";
import { AlertTriangle, FileWarning } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * The review step between a parsed resume and the profile.
 *
 * Resume parsing is lossy and occasionally wrong, and this profile is what the
 * fabrication gate checks generated resume claims against. So an import is a
 * proposal shown next to what is already on file, accepted per field, and it
 * still does not save — accepting fills the form, and the form's own save
 * button is the only thing that writes. Two deliberate acts, because the
 * destructive half is overwriting hand-written history with a guess.
 *
 * Fields the parser found nothing for are not offered at all: an absent phone
 * number in a PDF is not an instruction to delete the one on record.
 */
export function ImportReview({
  result,
  current,
  onAccept,
  onDiscard,
}: {
  result: ResumeImportResponse;
  current: ProfileDraft;
  /** Hands the merged draft back to the form. Never saves. */
  onAccept: (draft: ProfileDraft) => void;
  onDiscard: () => void;
}) {
  const rows = useMemo(
    () => reviewRows(current, result.draft),
    [current, result.draft],
  );
  const changed = rows.filter((row) => row.changed);

  // Pre-checked: the user uploaded the file in order to use it. Unchecking is
  // the exception, and every box is visible before anything is applied.
  const [accepted, setAccepted] = useState<ReviewPath[]>(() =>
    changed.map((row) => row.path),
  );

  const allOn = changed.length > 0 && accepted.length === changed.length;
  const empty = result.extractedChars === 0;

  return (
    <section
      aria-labelledby="review-heading"
      className="panel overflow-hidden border-signal/50"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ridge px-4 py-2.5">
        <h2 id="review-heading" className="u-meta text-ink-dim">
          Review import · {result.fileName}
        </h2>
        <span className="u-mono text-[11.5px] text-ink-faint tabular-nums">
          {formatCount(result.extractedChars)} characters read
        </span>
      </header>

      {/*
       * Warnings first and unmissable. A scanned PDF extracts nothing at all,
       * and the failure mode to avoid is an empty review that looks like "your
       * resume simply matched what was already here".
       */}
      {empty ? (
        <div
          role="alert"
          data-testid="import-empty"
          className="flex items-start gap-3 border-b border-ridge bg-alarm/10 px-4 py-3"
        >
          <FileWarning
            className="mt-0.5 size-4 shrink-0 text-alarm"
            aria-hidden
          />
          <p className="text-[13px] text-ink">
            No text could be read out of {result.fileName}. A scanned or
            image-only PDF has no text layer, so there is nothing to import.
            Export a text-based PDF or paste the content into the fields below.
          </p>
        </div>
      ) : null}

      {result.warnings.length > 0 ? (
        <div
          data-testid="import-warnings"
          className="border-b border-ridge bg-signal/10 px-4 py-3"
        >
          <p className="u-meta flex items-center gap-1.5 text-signal">
            <AlertTriangle className="size-3.5" aria-hidden />
            {result.warnings.length === 1
              ? "1 warning"
              : `${result.warnings.length} warnings`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {result.warnings.map((warning) => (
              <li key={warning} className="text-[13px] text-ink">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {changed.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-ink-dim">
          {empty
            ? "Nothing was extracted, so there is nothing to accept."
            : "Everything the resume states already matches this profile. Nothing to apply."}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-ridge px-4 py-2.5">
            <input
              id="review-accept-all"
              type="checkbox"
              checked={allOn}
              className="size-3.5 accent-signal"
              onChange={() =>
                setAccepted(allOn ? [] : changed.map((row) => row.path))
              }
            />
            <label
              htmlFor="review-accept-all"
              className="cursor-pointer text-[13px] text-ink-dim"
            >
              Accept all {changed.length}{" "}
              {changed.length === 1 ? "change" : "changes"}
            </label>
          </div>

          <ul>
            {changed.map((row) => {
              const on = accepted.includes(row.path);
              return (
                <li key={row.path} className="lane-row px-4 py-3">
                  <div className="flex items-start gap-2">
                    <input
                      id={`review-${row.path}`}
                      type="checkbox"
                      checked={on}
                      className="mt-1 size-3.5 shrink-0 accent-signal"
                      onChange={() =>
                        setAccepted((was) =>
                          was.includes(row.path)
                            ? was.filter((entry) => entry !== row.path)
                            : [...was, row.path],
                        )
                      }
                    />
                    <label
                      htmlFor={`review-${row.path}`}
                      className="u-meta cursor-pointer text-ink-dim"
                    >
                      {row.label}
                    </label>
                  </div>

                  <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                    <div>
                      <p className="u-mono text-[11px] text-ink-faint">
                        On file
                      </p>
                      {row.current.length === 0 ? (
                        <p className="text-[13px] text-ink-faint italic">
                          not set
                        </p>
                      ) : (
                        <ul>
                          {row.current.map((line) => (
                            <li
                              key={line}
                              className={`text-[13px] leading-snug ${
                                on
                                  ? "text-ink-faint line-through"
                                  : "text-ink-dim"
                              }`}
                            >
                              {line}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <p className="u-mono text-[11px] text-ink-faint">
                        From the resume
                      </p>
                      <ul>
                        {row.incoming.map((line) => (
                          <li
                            key={line}
                            className={`text-[13px] leading-snug ${
                              on ? "text-ink" : "text-ink-faint"
                            }`}
                          >
                            {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ridge px-4 py-3">
        <p className="text-[12px] text-ink-faint">
          Accepting fills the form below. Nothing is stored until you save.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={onDiscard}>
            Discard import
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={accepted.length === 0}
            onClick={() =>
              onAccept(applyReview(current, result.draft, new Set(accepted)))
            }
          >
            Accept {accepted.length > 0 ? accepted.length : ""}{" "}
            {accepted.length === 1 ? "change" : "changes"}
          </button>
        </div>
      </footer>
    </section>
  );
}
