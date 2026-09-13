import type { AgentApp } from "@domain";
import { ApiError } from "@web/lib/api";
import { APP_PRESENTATION } from "@web/lib/apps";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Loader2,
} from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Names the external system a step or connector belongs to. The hue comes from
 * `data-app` in the stylesheet, so a chip can never drift from the rail node it
 * sits next to.
 */
export function AppChip({ app }: { app: AgentApp }) {
  return (
    <span className="app-chip u-meta" data-app={app}>
      {APP_PRESENTATION[app].label}
    </span>
  );
}

export function Panel({
  children,
  className = "",
  ...rest
}: ComponentPropsWithoutRef<"section">) {
  return (
    <section {...rest} className={`panel ${className}`}>
      {children}
    </section>
  );
}

/** Section heading: mono eyebrow on the left, optional controls on the right. */
export function PanelHead({
  title,
  aside,
}: {
  title: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-ridge px-4 py-2.5">
      <h2 className="u-meta text-ink-dim">{title}</h2>
      {aside}
    </header>
  );
}

export function Meter({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter" aria-hidden="true">
      <div
        className="meter-fill"
        data-strong={value >= 80}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Empty state as an instruction, not an apology. */
export function EmptyState({
  headline,
  action,
  children,
}: {
  headline: string;
  /** A command to paste, when the fix is a terminal away. */
  action?: string;
  /** The single control that resolves the emptiness. */
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="mx-auto max-w-[46ch] text-ink-dim">{headline}</p>
      {action ? <p className="u-mono mt-2 text-ink-faint">{action}</p> : null}
      {children ? (
        <div className="mt-4 flex justify-center">{children}</div>
      ) : null}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-alarm/50 bg-alarm/10 px-4 py-3"
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-alarm"
        aria-hidden
      />
      <p className="flex-1 text-sm text-ink">{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function DeepLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="u-mono inline-flex items-center gap-1 text-ink-dim underline decoration-ridge-hi underline-offset-3 hover:text-ink hover:decoration-signal"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/* ── status ─────────────────────────────────────────────────────────────── */

export type StatusTone = "pass" | "signal" | "alarm" | "muted";

const TONE_TEXT: Record<StatusTone, string> = {
  pass: "text-pass",
  signal: "text-signal",
  alarm: "text-alarm",
  muted: "text-ink-faint",
};

const TONE_ICON: Record<StatusTone, typeof CheckCircle2> = {
  pass: CheckCircle2,
  signal: Loader2,
  alarm: AlertTriangle,
  muted: CircleDashed,
};

/**
 * Status as glyph plus word, never hue alone: the four connector states have to
 * survive a projector, a colour-blind judge and a greyscale screenshot.
 */
export function StatusBadge({
  tone,
  label,
  spin = false,
}: {
  tone: StatusTone;
  label: string;
  spin?: boolean;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <span
      className={`u-meta inline-flex items-center gap-1.5 ${TONE_TEXT[tone]}`}
    >
      <Icon className={`size-3.5 shrink-0 ${spin ? "spin" : ""}`} aria-hidden />
      {label}
    </span>
  );
}

/* ── loading ────────────────────────────────────────────────────────────── */

/**
 * One grey block. Every loading state in the app is built from these rather
 * than a centred spinner, so the first paint already has the shape of the
 * answer and nothing jumps when the data lands.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skel ${className}`} />;
}

/**
 * Uneven widths on purpose: rows of identical length read as a loading
 * graphic, ragged ones read as text that has not arrived yet. The widths
 * double as stable keys, which is why they are distinct.
 */
const ROW_WIDTHS = [
  "w-[58%]",
  "w-[74%]",
  "w-[45%]",
  "w-[66%]",
  "w-[52%]",
  "w-[70%]",
  "w-[48%]",
  "w-[62%]",
] as const;

/** Stand-in for a list of `.lane-row`s: two lines of text plus a trailing tag. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div>
      {ROW_WIDTHS.slice(0, rows).map((width) => (
        <div
          key={width}
          className="lane-row flex items-center gap-4 px-4 py-3.5"
        >
          <span className="min-w-0 flex-1">
            <Skeleton className={`h-3.5 max-w-[20rem] ${width}`} />
            <Skeleton className="mt-2 h-2.5 w-[min(40%,13rem)]" />
          </span>
          <Skeleton className="h-2.5 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * A panel whose header is already truthful while its body is still a guess.
 * `label` ends in an ellipsis because the header is the only place a screen
 * reader is told that anything is pending.
 */
export function SkeletonPanel({
  label,
  rows = 4,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <Panel aria-busy="true">
      <PanelHead
        title={label}
        aside={<span className="u-meta text-ink-faint">Loading…</span>}
      />
      <SkeletonRows rows={rows} />
    </Panel>
  );
}

/* ── numbers ────────────────────────────────────────────────────────────── */

/**
 * One formatter instance for the whole app: constructing `Intl.NumberFormat`
 * is the expensive half, and a counter that re-renders on every poll would pay
 * it every time. Locale-aware grouping matters as soon as a board returns four
 * digits of postings.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined);

export function formatCount(value: number): string {
  return Number.isFinite(value) ? COUNT_FORMAT.format(value) : "—";
}

/* ── async state ────────────────────────────────────────────────────────── */

/** Prefers the server's own wording; only invents a message when there is none. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to the Command Center server.";
}

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

/**
 * The four states every screen owes the user, from one place: `loading` with no
 * `data` is the skeleton, `error` is the banner plus retry, `data` with zero
 * rows is the empty state, and a reload keeps the last good `data` on screen
 * instead of flashing back to a skeleton.
 *
 * `load` must be referentially stable — wrap it in `useCallback` — because it
 * is the effect's only dependency.
 */
export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic token: a slow first request that resolves after a fast reload
  // must not overwrite the newer answer.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    generation.current += 1;
    const token = generation.current;
    setLoading(true);
    try {
      const next = await load();
      if (generation.current !== token) return;
      setData(next);
      setError(null);
    } catch (cause) {
      if (generation.current !== token) return;
      setError(describeError(cause));
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
