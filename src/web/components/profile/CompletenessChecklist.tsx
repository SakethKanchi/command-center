import type { ProfileCompleteness } from "@domain";
import { Check, CircleDashed, ShieldAlert } from "lucide-react";

/**
 * What is still missing, by name.
 *
 * A percentage would be decoration. This profile is what the resume tailoring
 * reads AND what the fabrication gate checks a generated claim against, so an
 * incomplete profile does not degrade the output — it stops it. The user is
 * therefore owed the list of what to type next, and a plain statement of
 * whether the pipeline can run at all.
 *
 * `score` is shown only as a secondary number, next to the list that explains
 * it, because the list is the actionable half.
 */
export function CompletenessChecklist({
  completeness,
}: {
  completeness: ProfileCompleteness;
}) {
  const { score, missing, ready } = completeness;

  return (
    <section aria-labelledby="completeness-heading" className="panel">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ridge px-4 py-2.5">
        <h2 id="completeness-heading" className="u-meta text-ink-dim">
          Resume readiness
        </h2>
        <span className="u-mono text-[11.5px] text-ink-faint tabular-nums">
          {score}/100
        </span>
      </header>

      <div className="px-4 py-3.5">
        <p
          className={`flex items-start gap-2 text-[13px] ${ready ? "text-pass" : "text-signal"}`}
        >
          {ready ? (
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span className="text-ink">
            {ready
              ? "Complete enough to tailor a resume."
              : "Resume tailoring is blocked until the entries below are filled in. Anything the tailoring cannot find here, it is not allowed to invent."}
          </span>
        </p>

        {missing.length > 0 ? (
          <>
            <p className="u-meta mt-3.5 text-ink-faint">
              Missing ({missing.length})
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {missing.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-[13px] text-ink-dim"
                >
                  <CircleDashed
                    className="mt-0.5 size-3.5 shrink-0 text-signal"
                    aria-hidden
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
