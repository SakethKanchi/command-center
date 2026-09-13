import {
  Boxes,
  Plug,
  Route,
  Search,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { NavLink } from "react-router-dom";

/**
 * Six destinations, and the order is the workflow: say who you are, find a
 * role, watch it move through the pipeline, audit what the agent did, fix
 * whatever is not connected, and tune the machine. Nothing here is a mode
 * toggle — every entry is a URL.
 *
 * Profile leads because it is the input every later step reads: the resume
 * tailoring and the fabrication gate are both driven by it, so an app with an
 * empty profile cannot do the thing it exists to do. Settings is last because
 * it has working defaults — it is where you go when something is wrong, not
 * where you start.
 */
export const NAV_ITEMS = [
  { to: "/profile", label: "Profile", icon: UserRound },
  { to: "/", label: "Search", icon: Search },
  { to: "/pipeline", label: "Pipeline", icon: Boxes },
  { to: "/runs", label: "Runs", icon: Route },
  { to: "/apps", label: "Apps", icon: Plug },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal },
] as const;

export type NavPath = (typeof NAV_ITEMS)[number]["to"];
export type NavCounts = Partial<Record<NavPath, number>>;

/**
 * `NavLink` rather than a click handler on purpose: the browser's back button,
 * Cmd-click into a new tab and middle-click all have to keep working, and a
 * `div onClick` silently breaks every one of them.
 *
 * `end` is set only for `/` so that `/runs/run_7` still lights up Runs.
 */
export function Nav({
  counts = {},
  onNavigate,
}: {
  /** Rendered beside a label when the number is worth knowing at a glance. */
  counts?: NavCounts;
  /** Lets the mobile bar close itself once a destination is chosen. */
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Sections">
      <ul className="flex gap-1 md:flex-col md:gap-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const count = counts[item.to];
          return (
            <li key={item.to} className="min-w-0">
              <NavLink
                to={item.to}
                end={item.to === "/"}
                onClick={onNavigate}
                className="nav-item"
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
                {typeof count === "number" ? (
                  <span className="nav-count u-mono text-[11px] tabular-nums">
                    {count}
                  </span>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
