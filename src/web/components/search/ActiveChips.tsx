import type { JobSearchQuery } from "@domain";
import type { FilterChip } from "@web/components/search/filters";
import { truncate } from "@web/lib/format";
import { X } from "lucide-react";

/**
 * Every filter currently narrowing the list, each removable on its own, plus
 * one escape hatch. A filter the user cannot see is a filter they will blame
 * the data for.
 */
export function ActiveChips({
  chips,
  onRemove,
  onClearAll,
}: {
  chips: FilterChip[];
  onRemove: (clear: Partial<JobSearchQuery>) => void;
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;

  return (
    <ul
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Active filters"
    >
      {chips.map((chip) => (
        // A chip states a filter, so it is only useful read in full.
        // `shrink-0` makes a crowded row wrap instead of squeezing every label
        // into a stub, and the length cap is applied to the string rather than
        // by CSS overflow so the rendered width never depends on whether the
        // mono webfont has loaded. The full label stays in `aria-label`.
        <li key={chip.id} className="flex shrink-0">
          <button
            type="button"
            data-testid={`chip-${chip.id}`}
            aria-label={`Remove filter ${chip.label}`}
            className="u-mono inline-flex items-center gap-1.5 rounded-xs border border-ridge-hi bg-panel-hi px-2 py-1 whitespace-nowrap text-ink-dim hover:border-alarm hover:text-ink focus:outline-1 focus:outline-signal"
            onClick={() => onRemove(chip.clear)}
          >
            <span>{truncate(chip.label, 48)}</span>
            <X className="size-3 shrink-0" aria-hidden />
          </button>
        </li>
      ))}
      <li className="ml-1 flex">
        <button type="button" className="btn btn-danger" onClick={onClearAll}>
          Clear all
        </button>
      </li>
    </ul>
  );
}
