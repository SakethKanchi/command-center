import type { ResumeTemplate, ResumeTemplateId } from "@domain";
import { describeError } from "@web/components/ui";
import {
  fetchResumeTemplates,
  resumePreviewUrl,
  selectResumeTemplate,
} from "@web/lib/resume";
import { FileText, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Which template the agent renders with, and what it looks like.
 *
 * A radio group rather than a gallery of thumbnails: every template is the same
 * single-column document — the pipeline's ATS gate would fail anything else —
 * so a thumbnail would advertise a difference that is not there, while the one
 * or two sentences under each name say what actually changes.
 *
 * Choosing saves immediately. There is no second "apply" step because the
 * choice is one settings row, not an edit to the profile, and pairing it with
 * the profile's save button would imply the two commit together.
 *
 * The preview renders the *saved* profile. That is deliberate: it is the same
 * document the agent would attach to an application, so it must not show edits
 * that have not been written yet — the caller passes `dirty` and the panel says
 * so instead of quietly previewing stale data.
 */
export function TemplatePicker({
  ready,
  dirty,
}: {
  /** Profile completeness. The server refuses to render below it. */
  ready: boolean;
  /** Unsaved edits in the form; the preview cannot see them. */
  dirty: boolean;
}) {
  const [templates, setTemplates] = useState<ResumeTemplate[]>([]);
  const [selected, setSelected] = useState<ResumeTemplateId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Cache-buster, and the flag that says a preview is open. */
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const load = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load.current = controller;
    void (async () => {
      try {
        const answer = await fetchResumeTemplates(controller.signal);
        setTemplates([...answer.templates]);
        setSelected(answer.selected);
      } catch (cause) {
        if (!controller.signal.aborted) setError(describeError(cause));
      }
    })();
    return () => controller.abort();
  }, []);

  const choose = async (template: ResumeTemplateId) => {
    const previous = selected;
    setSelected(template);
    setSaving(true);
    setError(null);
    // An open preview is of the old template; re-point it at the new one.
    if (previewAt !== null) setPreviewAt(Date.now());
    try {
      const answer = await selectResumeTemplate(template);
      setSelected(answer.selected);
    } catch (cause) {
      setSelected(previous);
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="template-heading" className="panel">
      <header className="flex items-baseline justify-between gap-3 border-b border-ridge px-4 py-2.5">
        <div>
          <h2 id="template-heading" className="u-meta text-ink-dim">
            Resume template
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            Applied to every resume the agent renders.
          </p>
        </div>
        {saving ? (
          <Loader2 className="spin size-3.5 text-signal" aria-hidden />
        ) : null}
      </header>

      <div className="px-4 py-3.5">
        <fieldset className="flex flex-col gap-2" disabled={saving}>
          <legend className="sr-only">Resume template</legend>
          {templates.map((template) => {
            const active = template.id === selected;
            return (
              <label
                key={template.id}
                data-testid={`template-${template.id}`}
                data-selected={active}
                className={`flex cursor-pointer gap-2.5 rounded-sm border px-3 py-2.5 transition-colors duration-100 ${
                  active
                    ? "border-signal bg-signal/5"
                    : "border-ridge hover:border-ink-faint"
                }`}
              >
                <input
                  type="radio"
                  name="resume-template"
                  value={template.id}
                  checked={active}
                  className="mt-1 size-3.5 shrink-0 accent-signal"
                  onChange={() => void choose(template.id)}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] text-ink">
                    {template.label}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] text-ink-dim">
                    {template.description}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {error ? (
          <p
            role="alert"
            data-testid="template-error"
            className="mt-3 rounded-sm border border-alarm/50 bg-alarm/10 px-3 py-2 text-[12.5px] text-ink"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={selected === null || !ready}
            onClick={() => setPreviewAt(previewAt === null ? Date.now() : null)}
          >
            <FileText className="size-3.5" aria-hidden />
            {previewAt === null ? "Preview PDF" : "Hide preview"}
          </button>
          {selected !== null && ready ? (
            <a
              className="btn"
              href={resumePreviewUrl(selected, previewAt ?? 0)}
              download
            >
              Download
            </a>
          ) : null}
        </div>

        {!ready ? (
          <p className="mt-2 text-[12.5px] text-ink-faint">
            Preview needs a complete profile — the list above says what is
            missing.
          </p>
        ) : dirty ? (
          <p className="mt-2 text-[12.5px] text-signal">
            Showing the last saved profile. Save to see the edits on the page.
          </p>
        ) : null}

        {previewAt !== null && selected !== null && ready ? (
          <iframe
            key={`${selected}-${previewAt}`}
            title={`Resume preview (${selected})`}
            src={resumePreviewUrl(selected, previewAt)}
            className="mt-3 h-[26rem] w-full rounded-sm border border-ridge bg-white"
          />
        ) : null}
      </div>
    </section>
  );
}
