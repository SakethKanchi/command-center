import type { ProfileCompleteness, ProfileDraft } from "@domain";
import { PageHeader } from "@web/components/Header";
import { CompletenessChecklist } from "@web/components/profile/CompletenessChecklist";
import {
  Section,
  TextAreaField,
  TextField,
} from "@web/components/profile/FormFields";
import { ImportReview } from "@web/components/profile/ImportReview";
import {
  EducationEditor,
  LinksEditor,
  SkillsEditor,
} from "@web/components/profile/ListEditors";
import { ProjectsEditor } from "@web/components/profile/ProjectsEditor";
import { ResumeImport } from "@web/components/profile/ResumeImport";
import { RolesEditor } from "@web/components/profile/RolesEditor";
import { TemplatePicker } from "@web/components/profile/TemplatePicker";
import { describeError, ErrorBanner, Skeleton } from "@web/components/ui";
import type { FieldErrors, ResumeImportResponse } from "@web/lib/profile";
import {
  fetchProfile,
  isDirty,
  saveProfile,
  validateDraft,
} from "@web/lib/profile";
import { Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * The candidate profile, editable.
 *
 * This is the input every other screen depends on: the resume tailoring reads
 * it, and the fabrication gate refuses to state anything that is not in it. It
 * used to be a committed JSON file, which meant the app could only ever be one
 * person's. So the rules here follow from what the data is for:
 *
 * - An incomplete profile saves fine. The server's `completeness` is what says
 *   the resume pipeline is blocked, and it is shown as the list of what is
 *   missing rather than a percentage, because the list is the actionable half.
 * - An import is never an autosave. It arrives as a draft to review, and even
 *   accepting it only fills this form — the save button is the only write.
 * - Nothing intercepts paste. A profile is mostly pasted out of a document.
 */

/** Mirrors the real layout so nothing moves when the profile lands. */
function LoadingShape() {
  return (
    <div
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start"
      aria-busy="true"
    >
      <div className="flex flex-col gap-5">
        {["identity", "summary", "experience"].map((section) => (
          <div key={section} className="panel overflow-hidden">
            <div className="border-b border-ridge px-4 py-2.5">
              <Skeleton className="h-2.5 w-24" />
            </div>
            <div className="flex flex-col gap-3 px-4 py-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-[70%]" />
              <Skeleton className="h-8 w-[85%]" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-5">
        {["readiness", "import"].map((section) => (
          <div key={section} className="panel overflow-hidden">
            <div className="border-b border-ridge px-4 py-2.5">
              <Skeleton className="h-2.5 w-28" />
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-4">
              <Skeleton className="h-3 w-[80%]" />
              <Skeleton className="h-3 w-[55%]" />
              <Skeleton className="h-3 w-[68%]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProfilePage() {
  const navigate = useNavigate();

  const [saved, setSaved] = useState<ProfileDraft | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [completeness, setCompleteness] = useState<ProfileCompleteness | null>(
    null,
  );
  const [seeded, setSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  /** Counts rejected submits, so a repeat submit re-focuses the same field. */
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [review, setReview] = useState<ResumeImportResponse | null>(null);
  /** In-app link the user clicked while the form was dirty. */
  const [leaving, setLeaving] = useState<string | null>(null);

  const load = useRef<AbortController | null>(null);
  const saveLock = useRef(false);
  const stay = useRef<HTMLButtonElement | null>(null);

  const reload = useCallback(() => {
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    setLoading(true);

    void (async () => {
      try {
        const answer = await fetchProfile(controller.signal);
        setSaved(answer.profile);
        setDraft(answer.profile);
        setCompleteness(answer.completeness);
        setSeeded(answer.source === "seed");
        setLoadError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLoadError(describeError(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    reload();
    return () => load.current?.abort();
  }, [reload]);

  const dirty = saved !== null && draft !== null && isDirty(saved, draft);

  /*
   * Two halves to "warn before navigating away", because a reload and a click
   * on the sidebar are different events. `beforeunload` covers closing the tab,
   * a refresh and any URL typed into the address bar.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /*
   * The other half: an in-app link. `useBlocker` would be the tool for this,
   * but it needs a data router and this app mounts a plain `BrowserRouter`, so
   * the click is caught in the capture phase instead and replayed once the
   * user has answered. Modified clicks are left alone on purpose — opening the
   * link in a new tab loses nothing.
   */
  useEffect(() => {
    if (!dirty) return;

    const intercept = (event: MouseEvent) => {
      // Modified clicks only. A middle click never produces `click` in the
      // first place, and `defaultPrevented` is deliberately NOT consulted: a
      // click that something upstream has already neutralised is still a
      // click that could take this page down with unsaved edits on it.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target !== "" && anchor.target !== "_self") return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || href === "/profile") return;

      // Both, and in this order: `preventDefault` stops the browser following
      // the href, and `stopPropagation` stops the router, because the click
      // never reaches React's root listener at all.
      event.preventDefault();
      event.stopPropagation();
      setLeaving(href);
    };

    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);

  // The dialog opens from an intercepted click rather than from a button of
  // its own, so focus has to be placed into it explicitly or a keyboard user
  // is left tabbing behind a modal.
  useEffect(() => {
    if (leaving !== null) stay.current?.focus();
  }, [leaving]);

  /*
   * Focus the first invalid control in DOM order, which is not the order the
   * validator produced: the form's sections and the validator's checks are
   * free to be arranged differently, and the user's eye follows the page.
   */
  useEffect(() => {
    if (attempt === 0) return;
    const first = document.querySelector<HTMLElement>(
      '#profile-form [aria-invalid="true"]',
    );
    first?.focus();
  }, [attempt]);

  const patch = useCallback((change: Partial<ProfileDraft>) => {
    setDraft((current) => (current ? { ...current, ...change } : current));
    setNotice(null);
  }, []);

  const submit = async () => {
    if (!draft || saveLock.current) return;

    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setAttempt((was) => was + 1);
      setSaveError(null);
      return;
    }

    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const answer = await saveProfile(draft);
      setSaved(answer.profile);
      setDraft(answer.profile);
      setCompleteness(answer.completeness);
      setSeeded(false);
      setNotice("Profile saved.");
    } catch (cause) {
      setSaveError(describeError(cause));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  if (loading && draft === null) {
    return (
      <>
        <PageHeader
          title="Profile"
          subtitle="Loading the profile the resume tailoring reads from…"
        />
        <LoadingShape />
      </>
    );
  }

  if (loadError !== null && draft === null) {
    return (
      <>
        <PageHeader
          title="Profile"
          subtitle="Everything the agent writes about you comes from here."
        />
        <ErrorBanner message={loadError} onRetry={reload} />
      </>
    );
  }

  if (draft === null) return null;

  return (
    <>
      <PageHeader
        title="Profile"
        subtitle="Everything the agent writes about you comes from here. It cannot state a skill, a date or an employer that is not on this page."
      />

      {seeded ? (
        <p className="mb-4 rounded-md border border-signal/40 bg-signal/10 px-4 py-2.5 text-[13px] text-ink">
          This is the shipped example profile — nothing has been saved yet.
          Import a resume or edit it below to make the app yours.
        </p>
      ) : null}

      {saveError ? (
        <div className="mb-4">
          <ErrorBanner message={saveError} onRetry={() => void submit()} />
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <form
          id="profile-form"
          className="flex min-w-0 flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Section title="Identity">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                path="name"
                label="Name"
                value={draft.name}
                autoComplete="name"
                placeholder="Ada Lovelace"
                error={errors.name}
                onChange={(value) => patch({ name: value })}
              />
              <TextField
                path="headline"
                label="Headline"
                value={draft.headline}
                autoComplete="organization-title"
                placeholder="Staff Backend Engineer"
                hint="One line, used as the resume's title."
                onChange={(value) => patch({ headline: value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                path="email"
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={draft.email}
                placeholder="ada@example.com"
                error={errors.email}
                onChange={(value) => patch({ email: value })}
              />
              <TextField
                path="phone"
                label="Phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={draft.phone}
                placeholder="+1 416 555 0134"
                onChange={(value) =>
                  patch({ phone: value === "" ? null : value })
                }
              />
              <TextField
                path="location"
                label="Location"
                value={draft.location}
                autoComplete="address-level2"
                placeholder="Toronto, Canada"
                onChange={(value) =>
                  patch({ location: value === "" ? null : value })
                }
              />
            </div>
          </Section>

          <Section
            title="Summary"
            note="The paragraph the tailoring rewrites per posting. Keep it factual; it can only be narrowed, never invented."
          >
            <TextAreaField
              path="summary"
              label="Summary"
              rows={5}
              value={draft.summary}
              placeholder="Backend engineer, eight years on payments and high-write systems…"
              onChange={(value) => patch({ summary: value })}
            />
          </Section>

          <Section title="Links">
            <LinksEditor
              links={draft.links}
              errors={errors}
              onChange={(links) => patch({ links })}
            />
          </Section>

          <Section title="Skills">
            <SkillsEditor
              skills={draft.skills}
              errors={errors}
              onChange={(skills) => patch({ skills })}
            />
          </Section>

          <Section title="Experience">
            <RolesEditor
              roles={draft.roles}
              errors={errors}
              onChange={(roles) => patch({ roles })}
            />
          </Section>

          <Section
            title="Projects"
            note="Work with no employer attached — side projects, open source, coursework. The tailoring quotes these bullets the same way it quotes a role's."
          >
            <ProjectsEditor
              projects={draft.projects}
              errors={errors}
              onChange={(projects) => patch({ projects })}
            />
          </Section>

          <Section title="Education">
            <EducationEditor
              education={draft.education}
              errors={errors}
              onChange={(education) => patch({ education })}
            />
          </Section>

          {/*
           * One save button for the whole form, pinned so it is reachable from
           * any section. `sticky` rather than `fixed`: it stays inside the
           * form's column instead of covering the right-hand rail.
           */}
          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-ridge bg-deck/95 px-1 py-3">
            <p
              className="u-mono text-[12px] text-ink-dim"
              aria-live="polite"
              data-testid="save-state"
            >
              {saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : (notice ?? "No unsaved changes")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(saved);
                  setErrors({});
                  setNotice(null);
                }}
              >
                Discard changes
              </button>
              {/*
               * Enabled right up to the moment the request starts, including
               * while the form is invalid: a disabled submit cannot tell the
               * user why, and the validation message is the answer. The label
               * survives the spinner so the button never changes meaning.
               */}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="spin size-3.5" aria-hidden />
                ) : (
                  <Save className="size-3.5" aria-hidden />
                )}
                Save profile
              </button>
            </div>
          </div>
        </form>

        <div className="flex flex-col gap-5 lg:sticky lg:top-4">
          {completeness ? (
            <CompletenessChecklist completeness={completeness} />
          ) : null}

          <TemplatePicker ready={completeness?.ready === true} dirty={dirty} />

          <ResumeImport
            disabled={saving}
            onImported={(result) => {
              setReview(result);
              setNotice(null);
            }}
          />
        </div>
      </div>

      {review ? (
        <div className="mt-5">
          <ImportReview
            result={review}
            current={draft}
            onDiscard={() => setReview(null)}
            onAccept={(merged) => {
              // Fills the form only. The profile is written by the save
              // button and nothing else.
              setDraft(merged);
              setReview(null);
              setErrors({});
              setNotice(null);
            }}
          />
        </div>
      ) : null}

      {leaving !== null ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="leave-heading"
          className="fixed inset-0 z-40 flex items-center justify-center bg-deck/80 p-4"
        >
          <div className="panel w-full max-w-[34rem] p-5">
            <h2 id="leave-heading" className="u-display text-[1.1rem] text-ink">
              Leave with unsaved changes?
            </h2>
            <p className="mt-2 text-[13.5px] text-ink-dim">
              The profile edits on this page have not been saved. Leaving now
              discards them.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {/*
               * Focus lands on the safe choice. This dialog interrupts a
               * navigation the user did mean, so the destructive button must
               * not be one Enter away.
               */}
              <button
                type="button"
                ref={stay}
                className="btn"
                onClick={() => setLeaving(null)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void navigate(leaving)}
              >
                Discard and leave
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default ProfilePage;
