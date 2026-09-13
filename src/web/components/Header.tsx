import type { ReactNode } from "react";

/**
 * The one `h1` on a page, plus the page's own controls. The brand and the
 * section nav live in the shell, so this carries only what changes when the
 * route changes — which is why every page can state what it is without
 * repeating the product name.
 *
 * `subtitle` is a sentence, not a tagline: it says what the screen is for, so
 * a first-time judge does not have to infer it from the table below.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="u-display text-[1.5rem] leading-none text-ink">
          {title}
        </h1>
        <p className="mt-2 max-w-[70ch] text-[13.5px] text-ink-dim">
          {subtitle}
        </p>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
