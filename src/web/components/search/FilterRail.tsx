import type {
  FacetCount,
  JobSearchFacets,
  JobSearchQuery,
  JobStatus,
  JobTag,
  JobTagKind,
} from "@domain";
import {
  countryLabel,
  JOB_REGION_LABELS,
  JOB_STATUSES,
  JOB_TAG_KIND_LABELS,
  tagLabel,
} from "@domain";
import {
  POSTED_WITHIN_OPTIONS,
  YEARS_MAX,
} from "@web/components/search/filters";
import { formatCount } from "@web/components/ui";
import { suggestLocations } from "@web/lib/discover";
import { humanize } from "@web/lib/format";
import { Loader2, MapPin, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";

/**
 * Every way to narrow the list, in one column.
 *
 * All of it is native form controls on purpose: a `<fieldset>` announces the
 * group, a `<select>` and a checkbox are keyboard operable and screen-reader
 * legible for free, and none of it needs a widget library the rest of the app
 * does not already have.
 */

/** Empty string is the wire form of "any" — see the note on BoundSelect. */
const ANY = "";

type BoundOption = { value: number; label: string };

/** Min end tops out at "15+", because 15 with no upper bound *is* "15 or more". */
const MIN_YEAR_OPTIONS: BoundOption[] = Array.from(
  { length: YEARS_MAX + 1 },
  (_, years) => ({
    value: years,
    label: years === YEARS_MAX ? `${years}+` : String(years),
  }),
);
const MAX_YEAR_OPTIONS: BoundOption[] = MIN_YEAR_OPTIONS.map((option) => ({
  value: option.value,
  label: String(option.value),
}));
const SCORE_OPTIONS: BoundOption[] = Array.from({ length: 11 }, (_, step) => ({
  value: step * 10,
  label: String(step * 10),
}));

/**
 * Pay floors, in thousands. Coarse on purpose: a board states pay in round
 * numbers when it states it at all, and a finer control would imply a
 * precision the underlying prose does not have.
 */
const SALARY_OPTIONS: BoundOption[] = [
  60, 80, 100, 120, 150, 180, 220, 260, 300,
].map((thousands) => ({
  value: thousands * 1000,
  label: `$${thousands}k`,
}));

/** Skills shown before the rail offers the rest behind one click. */
const SKILLS_COLLAPSED = 12;

function Group({
  legend,
  children,
  note,
}: {
  legend: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <fieldset className="border-t border-ridge px-4 py-3.5">
      <legend className="u-meta px-1 text-ink-faint">{legend}</legend>
      {children}
      {note ? (
        <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">{note}</p>
      ) : null}
    </fieldset>
  );
}

/** A checkbox or radio plus its facet count, aligned into a scannable column. */
function Option({
  id,
  name,
  type,
  checked,
  label,
  count,
  onChange,
}: {
  id: string;
  name?: string;
  type: "checkbox" | "radio";
  checked: boolean;
  label: string;
  count?: number;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <input
        id={id}
        name={name}
        type={type}
        checked={checked}
        onChange={onChange}
        className="size-3.5 shrink-0 accent-signal"
      />
      <label
        htmlFor={id}
        className="min-w-0 flex-1 cursor-pointer truncate text-[13px] text-ink-dim"
      >
        {label}
      </label>
      {count === undefined ? null : (
        <span className="u-mono shrink-0 text-[11.5px] text-ink-faint">
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * One end of a numeric range.
 *
 * "Any" and "0" are different searches and the control has to say so: "any"
 * leaves the bound off the query entirely, while 0 asks for postings that
 * genuinely accept a zero-experience candidate. The empty `<option>` value
 * carries the first case; every other value is a real number, including zero.
 */
function BoundSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: number | undefined;
  options: BoundOption[];
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="u-mono text-[11px] text-ink-faint" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value === undefined ? ANY : String(value)}
        // Floor in `rem`, not `ch`: the widest label is "Any" plus the native
        // dropdown arrow, and a select clipped to "An" is a broken control.
        className="u-mono min-w-[4.75rem] rounded-sm border border-ridge-hi bg-panel px-1.5 py-1 text-ink focus:border-signal focus:outline-none"
        onChange={(event) =>
          onChange(
            event.target.value === ANY ? undefined : Number(event.target.value),
          )
        }
      >
        <option value={ANY}>Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * `1fr` tracks, not flex children: a grid track never shrinks below its
 * min-content width, so "Any" and "100" stay readable in the narrow rail
 * instead of clipping to "An".
 */
function Range({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
      {children}
    </div>
  );
}

/**
 * One multi-select value: a toggle with its facet count attached.
 *
 * Pills rather than a checkbox column because these lists are long — thirty
 * skills, a dozen countries — and thirty stacked checkboxes push every filter
 * below them off the screen. Wrapped pills cost four lines. The count stays on
 * the label because a value with two postings behind it is worth knowing about
 * before clicking.
 */
function Pill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`u-mono rounded-xs border px-1.5 py-0.5 text-[11px] whitespace-nowrap focus:outline-1 focus:outline-signal ${
        active
          ? "border-signal text-signal"
          : "border-ridge-hi text-ink-dim hover:border-ink-faint"
      }`}
      onClick={onClick}
    >
      {label} <span className="text-ink-faint">{count}</span>
    </button>
  );
}

function TagPills({
  entries,
  selected,
  onToggle,
}: {
  entries: JobSearchFacets["tags"];
  selected: readonly JobTag[];
  onToggle: (tag: JobTag) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((entry) => (
        <Pill
          key={entry.tag}
          label={tagLabel(entry.tag)}
          count={entry.count}
          active={selected.includes(entry.tag)}
          onClick={() => onToggle(entry.tag)}
        />
      ))}
    </div>
  );
}

/**
 * The place filter: free text with evidence attached.
 *
 * Suggestions come from the corpus itself with their row counts, because the
 * useful question is not "is Toronto a city" but "are there any Toronto jobs
 * in here". Typed text still commits unchanged — the server matches locations
 * as a substring, so "Ontario" and "Remote - US" are both legitimate searches
 * that no suggestion list would contain.
 *
 * Selections are chips rather than a multi-select: the rail is 260px wide and
 * a place name is long, so the only readable way to show three of them is one
 * per line with its own remove button.
 */
function LocationPicker({
  selected,
  known,
  loading,
  error,
  onRetry,
  onChange,
}: {
  selected: string[];
  /** Null until the lookup answers; an empty array means it answered empty. */
  known: FacetCount[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChange: (next: string[] | undefined) => void;
}) {
  const listId = useId();
  const optionId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  /** Index into `options`, or -1 when the typed text itself is the answer. */
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);

  const options = suggestLocations(known ?? [], text, selected);
  const showList = open && options.length > 0;

  const add = (value: string) => {
    const place = value.trim();
    if (place === "") return;
    const already = selected.some(
      (entry) => entry.toLowerCase() === place.toLowerCase(),
    );
    setText("");
    setActive(-1);
    setOpen(false);
    if (!already) onChange([...selected, place]);
    input.current?.focus();
  };

  const remove = (value: string) => {
    const next = selected.filter((entry) => entry !== value);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div>
      <div className="relative">
        <label
          className="u-mono text-[11px] text-ink-faint"
          htmlFor="filter-locations"
        >
          Place
        </label>
        <div className="relative mt-1">
          {loading ? (
            <Loader2
              className="spin pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-signal"
              aria-hidden
            />
          ) : (
            <MapPin
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
          )}
          <input
            id="filter-locations"
            ref={input}
            type="text"
            role="combobox"
            value={text}
            placeholder="City, region, country…"
            autoComplete="address-level2"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby="filter-locations-hint"
            aria-activedescendant={
              showList && active >= 0 ? `${optionId}-${active}` : undefined
            }
            className="h-8 w-full rounded-sm border border-ridge-hi bg-panel pr-2 pl-7 text-[13px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none"
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            // Blur is deferred so a click on an option is not cancelled by the
            // list unmounting from under the pointer.
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive((was) =>
                  options.length === 0 ? -1 : (was + 1) % options.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((was) =>
                  options.length === 0
                    ? -1
                    : (was <= 0 ? options.length : was) - 1,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const picked = active >= 0 ? options[active] : undefined;
                add(picked ? picked.value : event.currentTarget.value);
                return;
              }
              if (event.key === "Escape" && open) {
                // Only swallows the key while the list is showing, so Escape
                // still reaches the mobile filter sheet when it is not.
                event.preventDefault();
                setOpen(false);
                setActive(-1);
                return;
              }
              if (
                event.key === "Backspace" &&
                event.currentTarget.value === "" &&
                selected.length > 0
              ) {
                event.preventDefault();
                remove(selected[selected.length - 1] as string);
              }
            }}
          />
          {showList ? (
            // `div`, not `ul`: a listbox owns its options directly, and an
            // intervening `li` puts a list item between the combobox and the
            // thing `aria-activedescendant` points at.
            <div
              id={listId}
              role="listbox"
              aria-label="Matching places"
              className="panel absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto py-1"
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  id={`${optionId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  className={`flex min-h-[26px] w-full items-center gap-2 px-2 py-1 text-left text-[13px] ${
                    index === active
                      ? "bg-panel-hi text-ink"
                      : "text-ink-dim hover:bg-panel-hi hover:text-ink"
                  }`}
                  // Keeps focus in the input, so the deferred blur never fires
                  // between mousedown and click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(option.value)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {option.value}
                  </span>
                  <span className="u-mono shrink-0 text-[11.5px] text-ink-faint tabular-nums">
                    {formatCount(option.count)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <p
        id="filter-locations-hint"
        className="mt-1.5 text-[11.5px] leading-snug text-ink-faint"
      >
        {error
          ? "Known places could not be loaded."
          : loading
            ? "Loading known places…"
            : "Matched as a substring. Several places are OR-ed."}
        {error ? (
          <>
            {" "}
            <button
              type="button"
              className="u-mono text-signal underline decoration-ridge-hi underline-offset-2"
              onClick={onRetry}
            >
              Retry
            </button>
          </>
        ) : null}
      </p>

      {selected.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Selected places">
          {selected.map((place) => (
            <li key={place} className="flex">
              <button
                type="button"
                data-testid={`place-chip-${place}`}
                aria-label={`Remove place ${place}`}
                className="u-mono flex min-h-[26px] w-full items-center gap-1.5 rounded-xs border border-ridge-hi bg-panel-hi px-2 py-1 text-left text-ink-dim hover:border-alarm hover:text-ink"
                onClick={() => remove(place)}
              >
                <span className="min-w-0 flex-1 truncate">{place}</span>
                <X className="size-3 shrink-0" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FilterRail({
  query,
  facets,
  places,
  placesLoading,
  placesError,
  onReloadPlaces,
  onPatch,
}: {
  query: JobSearchQuery;
  facets: JobSearchFacets | null;
  /** Known locations for the typeahead; null until the lookup answers. */
  places: FacetCount[] | null;
  placesLoading: boolean;
  placesError: string | null;
  onReloadPlaces: () => void;
  onPatch: (next: Partial<JobSearchQuery>) => void;
}) {
  const sourceFacets = facets?.sources ?? [];
  const [allSkills, setAllSkills] = useState(false);

  const selectedTags = query.tags ?? [];
  /**
   * Facet rows for one kind, with the candidate's own selections kept even
   * when the current result set no longer contains them — a filter you cannot
   * see is a filter you cannot switch off.
   */
  const tagsOfKind = (kind: JobTagKind): JobSearchFacets["tags"] => {
    const rows = (facets?.tags ?? []).filter((entry) => entry.kind === kind);
    const missing = selectedTags
      .filter(
        (tag) =>
          tag.startsWith(`${kind}:`) &&
          !rows.some((entry) => entry.tag === tag),
      )
      .map((tag) => ({
        kind,
        value: tag.slice(kind.length + 1),
        tag,
        count: 0,
      }));
    return [...rows, ...missing];
  };

  function toggle<T extends string>(
    selected: T[] | undefined,
    value: T,
  ): T[] | undefined {
    const current = selected ?? [];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    return next.length > 0 ? next : undefined;
  }

  /**
   * Dragging one end of the experience window past the other would ask for an
   * impossible range, so the far end moves with it instead of quietly
   * returning nothing.
   */
  const setYears = (end: "min" | "max", next: number | undefined) => {
    if (next === undefined) {
      onPatch(
        end === "min" ? { minYears: undefined } : { maxYears: undefined },
      );
      return;
    }
    const { minYears, maxYears } = query;
    if (end === "min") {
      onPatch(
        maxYears !== undefined && maxYears < next
          ? { minYears: next, maxYears: next }
          : { minYears: next },
      );
      return;
    }
    onPatch(
      minYears !== undefined && minYears > next
        ? { minYears: next, maxYears: next }
        : { maxYears: next },
    );
  };

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 pt-3.5 pb-1">
        <span className="u-meta text-ink-dim">Filters</span>
      </div>

      <Group
        legend="Experience"
        note="Matched by overlap: a 3–6 year posting answers a 5–10 year search. Postings with no stated range drop out once either bound is set."
      >
        <Range>
          <BoundSelect
            id="filter-min-years"
            label="Min years"
            value={query.minYears}
            options={MIN_YEAR_OPTIONS}
            onChange={(next) => setYears("min", next)}
          />
          <span className="pb-1.5 text-ink-faint" aria-hidden>
            –
          </span>
          <BoundSelect
            id="filter-max-years"
            label="Max years"
            value={query.maxYears}
            options={MAX_YEAR_OPTIONS}
            onChange={(next) => setYears("max", next)}
          />
        </Range>
        {facets && facets.experience.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {facets.experience.map((bucket) => {
              const active =
                query.minYears === bucket.minYears &&
                query.maxYears === (bucket.maxYears ?? undefined);
              return (
                <button
                  key={bucket.label}
                  type="button"
                  aria-pressed={active}
                  className={`u-mono rounded-xs border px-1.5 py-0.5 text-[11px] whitespace-nowrap focus:outline-1 focus:outline-signal ${
                    active
                      ? "border-signal text-signal"
                      : "border-ridge-hi text-ink-dim hover:border-ink-faint"
                  }`}
                  onClick={() =>
                    onPatch({
                      minYears: bucket.minYears,
                      maxYears: bucket.maxYears ?? undefined,
                    })
                  }
                >
                  {bucket.label}{" "}
                  <span className="text-ink-faint">{bucket.count}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </Group>

      {/* Tags, kind by kind. Within a kind the picks are OR-ed — two skills
          widen the list — and across kinds they are AND-ed, which is the only
          reading that matches what the rail looks like. */}
      <Group
        legend={JOB_TAG_KIND_LABELS.level}
        note="From the title's own words. A posting whose title states no level is not filed under one."
      >
        {tagsOfKind("level").length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            No levels stated in this set.
          </p>
        ) : (
          <TagPills
            entries={tagsOfKind("level")}
            selected={selectedTags}
            onToggle={(tag) => onPatch({ tags: toggle(query.tags, tag) })}
          />
        )}
      </Group>

      <Group
        legend={JOB_TAG_KIND_LABELS.skill}
        note="Read out of the posting text. Picking two asks for either one."
      >
        {(() => {
          const skills = tagsOfKind("skill");
          if (skills.length === 0) {
            return (
              <p className="text-[12.5px] text-ink-faint">
                No stack named in this set.
              </p>
            );
          }
          // Selected skills stay visible past the cut, so collapsing the list
          // can never hide an active filter.
          const shown = allSkills
            ? skills
            : skills.filter(
                (entry, index) =>
                  index < SKILLS_COLLAPSED || selectedTags.includes(entry.tag),
              );
          return (
            <>
              <TagPills
                entries={shown}
                selected={selectedTags}
                onToggle={(tag) => onPatch({ tags: toggle(query.tags, tag) })}
              />
              {skills.length > shown.length || allSkills ? (
                <button
                  type="button"
                  className="u-mono mt-2 text-[11px] whitespace-nowrap text-ink-dim hover:text-ink focus:outline-1 focus:outline-signal"
                  onClick={() => setAllSkills(!allSkills)}
                >
                  {allSkills
                    ? "Show fewer"
                    : `Show all ${formatCount(skills.length)}`}
                </button>
              ) : null}
            </>
          );
        })()}
      </Group>

      {/* Place and remote are independent dimensions: "remote" is a work
          arrangement and a place is a market, and a remote role posted out of
          Toronto answers both. They share a fieldset because they answer the
          same question, never the same query key. */}
      <Group legend="Location">
        {/* Coarse before fine: the rollups answer "which continent" and
            "which country" without typing a place name, and the typeahead
            below them is for the city. A posting that stated no country is in
            none of these rows — unknown is not everywhere. */}
        {facets && facets.regions.length > 0 ? (
          <div className="mb-3">
            <span className="u-mono text-[11px] text-ink-faint">Region</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {facets.regions.map((facet) => (
                <Pill
                  key={facet.value}
                  label={JOB_REGION_LABELS[facet.value]}
                  count={facet.count}
                  active={query.regions?.includes(facet.value) ?? false}
                  onClick={() =>
                    onPatch({ regions: toggle(query.regions, facet.value) })
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        {facets && facets.countries.length > 0 ? (
          <div className="mb-3">
            <span className="u-mono text-[11px] text-ink-faint">Country</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {facets.countries.map((facet) => (
                <Pill
                  key={facet.value}
                  label={countryLabel(facet.value)}
                  count={facet.count}
                  active={query.countries?.includes(facet.value) ?? false}
                  onClick={() =>
                    onPatch({ countries: toggle(query.countries, facet.value) })
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        <LocationPicker
          selected={query.locations ?? []}
          known={places}
          loading={placesLoading}
          error={placesError}
          onRetry={onReloadPlaces}
          onChange={(next) => onPatch({ locations: next })}
        />
        <div className="mt-3 border-t border-ridge pt-2.5">
          <span className="u-mono text-[11px] text-ink-faint">
            Work arrangement
          </span>
        </div>
        <Option
          id="filter-remote-any"
          name="filter-remote"
          type="radio"
          checked={query.remote === undefined}
          label="Any"
          onChange={() => onPatch({ remote: undefined })}
        />
        <Option
          id="filter-remote-yes"
          name="filter-remote"
          type="radio"
          checked={query.remote === true}
          label="Remote"
          count={facets?.remote.remote}
          onChange={() => onPatch({ remote: true })}
        />
        <Option
          id="filter-remote-no"
          name="filter-remote"
          type="radio"
          checked={query.remote === false}
          label="On-site"
          count={facets?.remote.onsite}
          onChange={() => onPatch({ remote: false })}
        />
      </Group>

      <Group
        legend={JOB_TAG_KIND_LABELS.employment}
        note="A posting can state two — &ldquo;full-time or contract&rdquo; — and answers either."
      >
        {tagsOfKind("employment").length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            No employment type stated in this set.
          </p>
        ) : (
          <TagPills
            entries={tagsOfKind("employment")}
            selected={selectedTags}
            onToggle={(tag) => onPatch({ tags: toggle(query.tags, tag) })}
          />
        )}
      </Group>

      <Group
        legend={JOB_TAG_KIND_LABELS.eligibility}
        note="Whether applying is possible at all. Silence is not a yes: a posting that says nothing about sponsorship carries neither flag."
      >
        {tagsOfKind("eligibility").length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            Nothing in this set states its work-authorization terms.
          </p>
        ) : (
          <TagPills
            entries={tagsOfKind("eligibility")}
            selected={selectedTags}
            onToggle={(tag) => onPatch({ tags: toggle(query.tags, tag) })}
          />
        )}
      </Group>

      <Group legend="Fit score">
        <Range>
          <BoundSelect
            id="filter-min-score"
            label="Min fit"
            value={query.minScore}
            options={SCORE_OPTIONS}
            onChange={(next) => onPatch({ minScore: next })}
          />
          <span className="pb-1.5 text-ink-faint" aria-hidden>
            –
          </span>
          <BoundSelect
            id="filter-max-score"
            label="Max fit"
            value={query.maxScore}
            options={SCORE_OPTIONS}
            onChange={(next) => onPatch({ maxScore: next })}
          />
        </Range>
      </Group>

      <Group legend="Posted within">
        <Option
          id="filter-posted-any"
          name="filter-posted"
          type="radio"
          checked={query.postedWithinDays === undefined}
          label="Any time"
          onChange={() => onPatch({ postedWithinDays: undefined })}
        />
        {POSTED_WITHIN_OPTIONS.map((option) => (
          <Option
            key={option.days}
            id={`filter-posted-${option.days}`}
            name="filter-posted"
            type="radio"
            checked={query.postedWithinDays === option.days}
            label={`Last ${option.label}`}
            onChange={() => onPatch({ postedWithinDays: option.days })}
          />
        ))}
      </Group>

      <Group legend="Source">
        {sourceFacets.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            No sources ingested yet.
          </p>
        ) : (
          sourceFacets.map((facet) => (
            <Option
              key={facet.value}
              id={`filter-source-${facet.value}`}
              type="checkbox"
              checked={query.sources?.includes(facet.value) ?? false}
              label={facet.value}
              count={facet.count}
              onChange={() =>
                onPatch({ sources: toggle(query.sources, facet.value) })
              }
            />
          ))
        )}
      </Group>

      <Group legend="Status">
        {JOB_STATUSES.map((status) => (
          <Option
            key={status}
            id={`filter-status-${status}`}
            type="checkbox"
            checked={query.statuses?.includes(status) ?? false}
            label={humanize(status)}
            count={
              facets?.statuses.find((entry) => entry.value === status)?.count
            }
            onChange={() =>
              onPatch({ statuses: toggle<JobStatus>(query.statuses, status) })
            }
          />
        ))}
      </Group>

      <Group
        legend="Pay"
        note="A floor reads the top of the stated range and drops postings whose pay does not parse, which on this corpus is most of them. Ask for a stated salary instead when that is the real question."
      >
        <Option
          id="filter-has-salary"
          type="checkbox"
          checked={query.hasSalary === true}
          label="Salary stated"
          onChange={() =>
            onPatch({ hasSalary: query.hasSalary ? undefined : true })
          }
        />
        <div className="mt-2.5">
          <BoundSelect
            id="filter-min-salary"
            label="Pay at least"
            value={query.minSalary}
            options={SALARY_OPTIONS}
            onChange={(next) => onPatch({ minSalary: next })}
          />
        </div>
      </Group>
    </div>
  );
}
