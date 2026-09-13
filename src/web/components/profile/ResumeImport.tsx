import { describeError } from "@web/components/ui";
import type { ResumeImportResponse } from "@web/lib/profile";
import {
  importResume,
  MAX_RESUME_BYTES,
  RESUME_ACCEPT,
  RESUME_EXTENSIONS,
  rejectResume,
} from "@web/lib/profile";
import { FileUp, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Bring an existing resume in.
 *
 * Two entry points, because both habits are real: a dropzone for the file
 * already sitting on the desktop, and a plain file input for everyone who
 * navigates with a keyboard or does not trust drag targets. The dropzone is a
 * `<label>` wrapping that same input, so the visible affordance and the
 * accessible control are one element rather than two that can disagree.
 *
 * Nothing here writes to the profile. The result is handed up as a proposal
 * for review, which is the whole point: a parser that silently overwrote a
 * hand-written profile would be worse than no import at all.
 */
export function ResumeImport({
  onImported,
  disabled,
}: {
  /** A parsed draft to review. Never applied by this component. */
  onImported: (result: ResumeImportResponse) => void;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const send = async (file: File) => {
    const refusal = rejectResume(file);
    if (refusal) {
      // Local refusal, not a failed request: the form keeps everything the
      // user has typed and the message lands on the zone they just used.
      setError(refusal);
      setPending(null);
      return;
    }

    setError(null);
    setPending(file.name);
    setSent(0);
    setBusy(true);
    try {
      const result = await importResume(file, {
        onProgress: (fraction) => setSent(fraction),
      });
      onImported(result);
      setPending(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
      // Clearing the input is what makes re-picking the same file work: a
      // file input with an unchanged value fires no `change` event.
      if (input.current) input.current.value = "";
    }
  };

  const percent = Math.round(sent * 100);

  return (
    <section aria-labelledby="import-heading" className="panel">
      <header className="border-b border-ridge px-4 py-2.5">
        <h2 id="import-heading" className="u-meta text-ink-dim">
          Import a resume
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-faint">
          Read into a draft you review before anything is saved.
        </p>
      </header>

      <div className="px-4 py-4">
        <label
          htmlFor="resume-file"
          data-testid="resume-dropzone"
          data-over={over}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-sm border border-dashed px-4 py-7 text-center transition-colors duration-100 ${
            over
              ? "border-signal bg-signal/5"
              : error
                ? "border-alarm"
                : "border-ridge-hi hover:border-ink-faint"
          } ${disabled ? "pointer-events-none opacity-50" : ""}`}
          onDragOver={(event) => {
            // Required, or the browser navigates to the dropped file and the
            // whole page is replaced by a PDF viewer.
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            const file = event.dataTransfer?.files?.[0];
            if (file) void send(file);
          }}
        >
          {busy ? (
            <Loader2 className="spin size-5 text-signal" aria-hidden />
          ) : (
            <FileUp className="size-5 text-ink-faint" aria-hidden />
          )}
          <span className="text-[13.5px] text-ink-dim">
            Drop a resume here, or{" "}
            <span className="text-signal underline decoration-ridge-hi underline-offset-3">
              choose a file
            </span>
          </span>
          <span className="u-mono text-[11px] text-ink-faint">
            {RESUME_EXTENSIONS.join(" · ")} · up to{" "}
            {Math.round(MAX_RESUME_BYTES / (1024 * 1024))} MB
          </span>
        </label>

        <input
          id="resume-file"
          ref={input}
          type="file"
          accept={RESUME_ACCEPT}
          disabled={disabled || busy}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
          }}
        />

        {busy && pending ? (
          <div className="mt-3">
            <p className="u-mono flex items-baseline justify-between gap-3 text-[12px] text-ink-dim">
              <span className="min-w-0 flex-1 truncate">
                Uploading {pending}…
              </span>
              <span className="shrink-0 tabular-nums">{percent}%</span>
            </p>
            {/*
             * A real `<progress>`: it is announced as a progress bar, it has
             * a value a screen reader can read, and it needs no ARIA to say
             * so. Transform-only fill, per the motion budget.
             */}
            <progress
              className="sr-only"
              value={percent}
              max={100}
              aria-label={`Uploading ${pending}`}
            />
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-xs bg-ridge">
              <div
                className="h-full origin-left bg-signal transition-transform duration-150"
                style={{ transform: `scaleX(${Math.max(sent, 0.02)})` }}
              />
            </div>
            {percent === 100 ? (
              <p className="mt-1.5 text-[12px] text-ink-faint">
                Reading the document…
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          // On the zone, not in a page banner: the thing that went wrong is
          // the file, and the next action is dropping a different one.
          <p
            role="alert"
            data-testid="dropzone-error"
            className="mt-3 flex items-start gap-2 rounded-sm border border-alarm/50 bg-alarm/10 px-3 py-2 text-[12.5px] text-ink"
          >
            <Upload
              className="mt-0.5 size-3.5 shrink-0 text-alarm"
              aria-hidden
            />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
