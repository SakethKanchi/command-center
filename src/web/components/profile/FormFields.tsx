import type { FieldPath } from "@web/lib/profile";
import { fieldId } from "@web/lib/profile";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The form vocabulary for the profile screen: a labelled control, a repeatable
 * row, and the three buttons that reorder one.
 *
 * Every control here is a real `<input>` or `<textarea>` with a real
 * `<label for>`, and none of them intercept `paste`, `drop` or `keydown`. A
 * profile is mostly copied out of an existing resume, so a field that fights
 * paste is a field the user cannot fill.
 *
 * The `path` prop is the single source of the DOM id, the label's `for` and
 * the error lookup key, which is what lets the page focus the first invalid
 * control without knowing anything about this file's markup.
 */

const INPUT_CLASS =
  "min-h-[32px] w-full rounded-sm border border-ridge-hi bg-panel px-2.5 py-1.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none";

function Shell({
  path,
  label,
  hint,
  error,
  children,
}: {
  path: FieldPath;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label
        className="u-mono text-[11px] text-ink-faint"
        htmlFor={fieldId(path)}
      >
        {label}
      </label>
      {children}
      {error ? (
        <p
          id={`${fieldId(path)}-error`}
          className="text-[12px] leading-snug text-alarm"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={`${fieldId(path)}-hint`}
          className="text-[11.5px] leading-snug text-ink-faint"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  path,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputMode,
  placeholder,
  hint,
  error,
}: {
  path: FieldPath;
  label: string;
  /** Null is accepted so an optional draft field needs no coercion at the call site. */
  value: string | null;
  onChange: (next: string) => void;
  type?: "text" | "email" | "tel" | "url";
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "url";
  placeholder?: string;
  hint?: string;
  error?: string;
}) {
  const id = fieldId(path);
  return (
    <Shell path={path} label={label} hint={hint} error={error}>
      <input
        id={id}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
        className={`${INPUT_CLASS} ${error ? "border-alarm" : ""}`}
        onChange={(event) => onChange(event.target.value)}
      />
    </Shell>
  );
}

export function TextAreaField({
  path,
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
  hint,
  error,
}: {
  path: FieldPath;
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  hint?: string;
  error?: string;
}) {
  const id = fieldId(path);
  return (
    <Shell path={path} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
        className={`${INPUT_CLASS} resize-y leading-relaxed ${error ? "border-alarm" : ""}`}
        onChange={(event) => onChange(event.target.value)}
      />
    </Shell>
  );
}

/**
 * A 26px square icon button. Past the 24px floor without being a full `.btn`,
 * because a row with four word-labelled buttons on it is unreadable.
 */
function IconButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`inline-flex size-[26px] shrink-0 items-center justify-center rounded-xs border border-ridge-hi text-ink-faint disabled:opacity-35 ${
        danger ? "hover:border-alarm hover:text-alarm" : "hover:text-ink"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Reorder and remove for one entry of a repeated list.
 *
 * Up and down rather than drag: order matters on a resume, and a pointer-only
 * drag handle would put the one ordering decision the document depends on out
 * of reach of the keyboard.
 */
export function RowControls({
  what,
  index,
  count,
  onMove,
  onRemove,
}: {
  /** Singular noun for the labels: "role", "bullet", "link". */
  what: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const position = `${what} ${index + 1}`;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <IconButton
        label={`Move ${position} up`}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        <ArrowUp className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton
        label={`Move ${position} down`}
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        <ArrowDown className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton
        label={`Remove ${position}`}
        danger
        onClick={() => onRemove(index)}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

export function AddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="btn" onClick={onClick}>
      <Plus className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

/**
 * One section of the form. `h2` on every one of them, in document order, so
 * the page outline under the single `h1` is the list of things a profile is
 * made of.
 */
export function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-ridge px-4 py-2.5">
        <h2 className="u-meta text-ink-dim">{title}</h2>
        {note ? (
          <p className="mt-1 text-[12.5px] text-ink-faint">{note}</p>
        ) : null}
      </header>
      <div className="flex flex-col gap-4 px-4 py-4">{children}</div>
    </section>
  );
}

/** A bordered card for one entry of a repeated list. */
export function RowCard({
  children,
  controls,
  title,
}: {
  children: ReactNode;
  controls: ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-sm border border-ridge bg-panel-hi/40 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="u-meta text-ink-faint">{title}</span>
        {controls}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/** Nothing in this list yet, said in one line instead of a blank area. */
export function EmptyRows({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-ink-faint">{children}</p>;
}
