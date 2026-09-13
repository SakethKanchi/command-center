import type { AgentSettings, SettingSource } from "@domain";
import { PageHeader } from "@web/components/Header";
import { describeError, ErrorBanner, Skeleton } from "@web/components/ui";
import type {
  ConnectionTest,
  ModelOption,
  SettingsBounds,
  SettingsResponse,
} from "@web/lib/settings";
import {
  fetchModels,
  fetchSettings,
  saveAgentSettings,
  saveLlmSettings,
  testLlmConnection,
} from "@web/lib/settings";
import { KeyRound, Loader2, PlugZap, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

/**
 * Everything the app runs on that is not the profile: which model it calls, and
 * the three numbers that decide when a run stops.
 *
 * The screen's job is to remove a restart from the loop. Model configuration
 * used to be `.env` only, which meant changing a model meant editing a file and
 * bouncing the server — fine for the machine that provisioned it, useless for
 * the person using it. So a stored value overrides the variable, and every
 * field says which of the two is in force, because "the model is wrong" and
 * "the model I set is being ignored" are indistinguishable otherwise.
 *
 * Two things are deliberate:
 *
 * - The API key goes one way. It is never sent back, and the field shows only
 *   the last four characters of whatever is in force. A screen that can display
 *   a credential is a screen that can leak one over a shoulder or a screenshare.
 * - The connection test is a real call. Validating the shape of a key proves
 *   nothing; spending one tiny completion against the exact configuration the
 *   agent would use is the only answer worth printing.
 */

const SOURCE_LABEL: Record<SettingSource, string> = {
  setting: "saved here",
  env: "from .env",
  default: "built-in default",
};

function SourceChip({ source }: { source: SettingSource }) {
  return (
    <span className="u-meta rounded-xs border border-ridge-hi px-1.5 py-px text-ink-faint">
      {SOURCE_LABEL[source]}
    </span>
  );
}

const INPUT_CLASS =
  "min-h-[32px] w-full rounded-sm border border-ridge-hi bg-panel px-2.5 py-1.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none";

function Field({
  id,
  label,
  hint,
  source,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  source?: SettingSource;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="u-meta text-ink-dim">
          {label}
        </label>
        {source ? <SourceChip source={source} /> : null}
      </div>
      <div className="mt-1.5">{children}</div>
      {hint ? (
        <p className="mt-1 text-[12.5px] text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

/** Mirrors the real layout so nothing jumps when the settings land. */
function LoadingShape() {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]" aria-busy>
      <div className="flex flex-col gap-5">
        {["model", "thresholds"].map((panel) => (
          <div key={panel} className="panel overflow-hidden">
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
      <div className="panel overflow-hidden">
        <div className="border-b border-ridge px-4 py-2.5">
          <Skeleton className="h-2.5 w-28" />
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-4">
          <Skeleton className="h-3 w-[80%]" />
          <Skeleton className="h-3 w-[55%]" />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [state, setState] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    setLoading(true);
    void (async () => {
      try {
        const answer = await fetchSettings(controller.signal);
        setState(answer);
        setLoadError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(describeError(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    reload();
    return () => load.current?.abort();
  }, [reload]);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Which model the agent calls, and the thresholds that decide when a run stops. Changes apply to the next model call — nothing here needs a restart."
      />

      {loadError ? (
        <ErrorBanner message={loadError} onRetry={reload} />
      ) : loading || state === null ? (
        <LoadingShape />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <div className="flex flex-col gap-5">
            <ModelPanel
              settings={state.settings.llm}
              onSaved={(llm) =>
                setState((prev) =>
                  prev
                    ? { ...prev, settings: { ...prev.settings, llm } }
                    : prev,
                )
              }
            />
            <ThresholdPanel
              settings={state.settings.agent}
              bounds={state.bounds}
              onSaved={(agent) =>
                setState((prev) =>
                  prev
                    ? { ...prev, settings: { ...prev.settings, agent } }
                    : prev,
                )
              }
            />
          </div>

          <div className="flex flex-col gap-5 lg:sticky lg:top-4">
            <ConnectionPanel
              model={state.settings.llm.model}
              configured={state.settings.llm.apiKeyConfigured}
            />
            <aside className="panel px-4 py-3.5">
              <h2 className="u-meta text-ink-dim">Elsewhere</h2>
              <p className="mt-2 text-[12.5px] text-ink-dim">
                The resume template lives on{" "}
                <Link to="/profile" className="text-signal underline">
                  Profile
                </Link>
                , next to the document it changes. Connected apps are on{" "}
                <Link to="/apps" className="text-signal underline">
                  Apps
                </Link>
                .
              </p>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

type LlmSettings = SettingsResponse["settings"]["llm"];

function ModelPanel({
  settings,
  onSaved,
}: {
  settings: LlmSettings;
  onSaved: (llm: LlmSettings) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const dirty =
    baseUrl.trim() !== settings.baseUrl ||
    model.trim() !== settings.model ||
    apiKey !== "";

  const save = async (patch: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  }) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await saveLlmSettings(patch);
      onSaved(answer.llm);
      setBaseUrl(answer.llm.baseUrl);
      setModel(answer.llm.model);
      setApiKey("");
      setNotice("Saved. The next model call uses it.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  const list = async () => {
    setListing(true);
    setListError(null);
    try {
      const answer = await fetchModels(baseUrl.trim());
      setModels(answer.models);
      if (answer.models.length === 0) {
        setListError("The provider returned no models.");
      }
    } catch (cause) {
      setListError(describeError(cause));
    } finally {
      setListing(false);
    }
  };

  return (
    <section aria-labelledby="model-heading" className="panel">
      <header className="flex items-baseline justify-between gap-3 border-b border-ridge px-4 py-2.5">
        <div>
          <h2 id="model-heading" className="u-meta text-ink-dim">
            Model
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            Scoring, tailoring, outreach and resume import all call this one.
          </p>
        </div>
        {saving ? (
          <Loader2 className="spin size-3.5 text-signal" aria-hidden />
        ) : null}
      </header>

      <form
        className="flex flex-col gap-3.5 px-4 py-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
          });
        }}
      >
        <Field
          id="llm-base-url"
          label="Provider base URL"
          source={settings.baseUrlSource}
          hint="Any OpenAI-compatible endpoint, ending at /v1."
        >
          <input
            id="llm-base-url"
            className={INPUT_CLASS}
            value={baseUrl}
            inputMode="url"
            spellCheck={false}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>

        <Field
          id="llm-model"
          label="Model"
          source={settings.modelSource}
          hint={
            listError ??
            "Type an id, or list what this provider offers and pick one."
          }
        >
          <div className="flex flex-wrap gap-2">
            <input
              id="llm-model"
              className={`${INPUT_CLASS} flex-1`}
              value={model}
              list="llm-model-options"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={listing}
              onClick={() => void list()}
            >
              {listing ? (
                <Loader2 className="spin size-3.5" aria-hidden />
              ) : null}
              {models === null ? "List models" : `${models.length} available`}
            </button>
          </div>
          {models !== null ? (
            <datalist id="llm-model-options" data-testid="model-options">
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </datalist>
          ) : null}
        </Field>

        <Field
          id="llm-api-key"
          label="API key"
          source={settings.apiKeyConfigured ? settings.apiKeySource : undefined}
          hint={
            settings.apiKeyConfigured
              ? `A key ending ${settings.apiKeyHint} is in use. Typing here replaces it.`
              : "No key is configured, so every model call fails until one is."
          }
        >
          <div className="flex flex-wrap gap-2">
            <input
              id="llm-api-key"
              type="password"
              className={`${INPUT_CLASS} flex-1`}
              value={apiKey}
              autoComplete="off"
              placeholder={
                settings.apiKeyConfigured ? "••••••••" : "sk-or-v1-…"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
            {settings.apiKeySource === "setting" ? (
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={() => void save({ apiKey: null })}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Clear
              </button>
            ) : null}
          </div>
        </Field>

        {error ? (
          <p
            role="alert"
            data-testid="model-error"
            className="rounded-sm border border-alarm/50 bg-alarm/10 px-3 py-2 text-[12.5px] text-ink"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="u-mono text-[12px] text-ink-dim"
            aria-live="polite"
            data-testid="model-state"
          >
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : (notice ?? "No unsaved changes")}
          </p>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? (
              <Loader2 className="spin size-3.5" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            Save model
          </button>
        </div>
      </form>
    </section>
  );
}

/** What each number does, in the terms the run trace uses. */
const THRESHOLD_COPY: Record<
  keyof AgentSettings,
  { label: string; hint: string }
> = {
  fitMinScore: {
    label: "Fit floor",
    hint: "Below this score the plan stops before tailoring. Applying with force overrides it for one run.",
  },
  atsMinScore: {
    label: "ATS floor",
    hint: "A rendered resume scoring below this never leaves the machine. 70 is what the evals assert.",
  },
  followUpDelayDays: {
    label: "Follow-up delay",
    hint: "Days after applying before the agent schedules a nudge. An opened resume is chased sooner.",
  },
};

const THRESHOLD_FIELDS = [
  "fitMinScore",
  "atsMinScore",
  "followUpDelayDays",
] as const;

function ThresholdPanel({
  settings,
  bounds,
  onSaved,
}: {
  settings: AgentSettings;
  bounds: SettingsBounds;
  onSaved: (agent: AgentSettings) => void;
}) {
  const [draft, setDraft] = useState<AgentSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = THRESHOLD_FIELDS.some(
    (field) => draft[field] !== settings[field],
  );

  return (
    <section aria-labelledby="thresholds-heading" className="panel">
      <header className="border-b border-ridge px-4 py-2.5">
        <h2 id="thresholds-heading" className="u-meta text-ink-dim">
          Agent thresholds
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-faint">
          Where a run stops on its own. Every halt names the number that caused
          it in the trace.
        </p>
      </header>

      <form
        className="flex flex-col gap-3.5 px-4 py-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          setNotice(null);
          void (async () => {
            try {
              const answer = await saveAgentSettings(draft);
              onSaved(answer.agent);
              setDraft(answer.agent);
              setNotice("Saved. The next run uses these.");
            } catch (cause) {
              setError(describeError(cause));
            } finally {
              setSaving(false);
            }
          })();
        }}
      >
        {THRESHOLD_FIELDS.map((field) => (
          <Field
            key={field}
            id={`agent-${field}`}
            label={THRESHOLD_COPY[field].label}
            hint={THRESHOLD_COPY[field].hint}
          >
            <div className="flex items-center gap-2">
              <input
                id={`agent-${field}`}
                type="number"
                className={`${INPUT_CLASS} max-w-[7rem]`}
                value={draft[field]}
                min={bounds[field].min}
                max={bounds[field].max}
                step={1}
                onChange={(event) =>
                  setDraft({ ...draft, [field]: event.target.valueAsNumber })
                }
              />
              <span className="u-meta text-ink-faint">
                {bounds[field].min}–{bounds[field].max}
                {field === "followUpDelayDays" ? " days" : ""}
              </span>
            </div>
          </Field>
        ))}

        {error ? (
          <p
            role="alert"
            data-testid="threshold-error"
            className="rounded-sm border border-alarm/50 bg-alarm/10 px-3 py-2 text-[12.5px] text-ink"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="u-mono text-[12px] text-ink-dim"
            aria-live="polite"
            data-testid="threshold-state"
          >
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : (notice ?? "No unsaved changes")}
          </p>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? (
              <Loader2 className="spin size-3.5" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            Save thresholds
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * The test is its own panel rather than a button beside the key, because its
 * answer outlives the save: it is the last evidence that this configuration
 * reached a model, and it should still be on screen while the thresholds below
 * are being edited.
 */
function ConnectionPanel({
  model,
  configured,
}: {
  model: string;
  configured: boolean;
}) {
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="connection-heading" className="panel px-4 py-3.5">
      <h2 id="connection-heading" className="u-meta text-ink-dim">
        Connection
      </h2>
      <p className="mt-2 text-[12.5px] text-ink-dim">
        Sends one small request to{" "}
        <span className="u-mono text-ink">{model}</span> and reports what came
        back.
      </p>

      <button
        type="button"
        className="btn mt-3"
        disabled={testing}
        onClick={() => {
          setTesting(true);
          setError(null);
          void (async () => {
            try {
              setResult(await testLlmConnection());
            } catch (cause) {
              setError(describeError(cause));
            } finally {
              setTesting(false);
            }
          })();
        }}
      >
        {testing ? (
          <Loader2 className="spin size-3.5" aria-hidden />
        ) : configured ? (
          <PlugZap className="size-3.5" aria-hidden />
        ) : (
          <KeyRound className="size-3.5" aria-hidden />
        )}
        Test connection
      </button>

      {(error ?? result) ? (
        <p
          data-testid="connection-result"
          aria-live="polite"
          className={`mt-3 rounded-sm border px-3 py-2 text-[12.5px] ${
            error || result?.ok === false
              ? "border-alarm/50 bg-alarm/10 text-ink"
              : "border-pass/50 bg-pass/10 text-ink"
          }`}
        >
          {error ?? result?.message}
        </p>
      ) : null}
    </section>
  );
}

export default SettingsPage;
