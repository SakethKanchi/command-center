import type { ConnectorHealth } from "@domain";
import { request } from "@web/lib/api";
import { Menu, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Nav } from "./Nav";
import { StatusBadge, useResource } from "./ui";

/**
 * The frame every page renders into: a persistent rail on the left, one `main`
 * on the right. The rail collapses to a top bar under `md` because a 220px
 * sidebar on a phone leaves no room for a job title.
 *
 * The shell owns exactly one piece of data — how many apps are connected —
 * because that number is the difference between a demo that works and one that
 * quietly does nothing, and it belongs in front of the user on every screen.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(pathname);

  // Adjusted during render rather than in an effect: a route change — including
  // one from the back button, which no click handler sees — closes the mobile
  // menu before paint, so the panel never flashes over the page it covered.
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }

  const loadHealth = useCallback(
    () => request<{ health: ConnectorHealth[] }>("/api/connectors"),
    [],
  );
  const connectors = useResource(loadHealth);

  const health = connectors.data?.health ?? [];
  const connected = health.filter((entry) => entry.connected).length;

  return (
    <div className="min-h-screen md:flex">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="sticky top-0 z-30 shrink-0 border-b border-ridge bg-deck md:h-screen md:w-[216px] md:overflow-y-auto md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-4 py-3.5 md:px-3">
          <Link
            to="/"
            className="flex min-w-0 items-center gap-2.5 rounded-sm no-underline"
          >
            <span
              aria-hidden
              className="block h-6 w-1.5 rounded-xs bg-signal"
            />
            <span className="u-display truncate text-[1.05rem] leading-none text-ink">
              Command Center
            </span>
          </Link>

          <button
            type="button"
            className="btn ml-auto md:hidden"
            aria-expanded={menuOpen}
            aria-controls="shell-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="size-3.5" aria-hidden />
            ) : (
              <Menu className="size-3.5" aria-hidden />
            )}
            Menu
          </button>
        </div>

        <div
          id="shell-nav"
          className={`border-t border-ridge px-2 py-2 md:block md:border-t-0 ${menuOpen ? "block" : "hidden"}`}
        >
          <Nav onNavigate={() => setMenuOpen(false)} />

          <div className="mt-3 border-t border-ridge px-2 pt-3">
            <p className="u-meta text-ink-faint">Connected apps</p>
            <p className="u-mono mt-1 flex items-baseline gap-1 text-ink tabular-nums">
              <span
                data-testid="connected-count"
                className={connected > 0 ? "text-pass" : "text-signal"}
              >
                {connected}
              </span>
              <span className="text-ink-faint">
                / {health.length || 3} ready
              </span>
            </p>
            {connectors.error ? (
              <p className="mt-1.5">
                <StatusBadge tone="alarm" label="Status unknown" />
              </p>
            ) : null}
            {/* min-h-6 + py-1 rather than a bare inline link: 11.5px mono text
                on its own is an 18px tap target, under the 24px floor. */}
            {!connectors.error && connected === 0 && !connectors.loading ? (
              <Link
                to="/apps"
                className="u-mono mt-1.5 inline-flex min-h-6 items-center rounded-sm py-1 text-[11.5px] text-signal underline decoration-signal/40 underline-offset-3 hover:decoration-signal"
              >
                Connect your first app
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      {/* tabIndex -1 so the skip link can actually land focus here, and the
          default focus ring is deliberately left in place so a keyboard user
          sees where they arrived. min-w-0 so a long job title truncates
          instead of widening the flex row. */}
      <main
        id="main"
        tabIndex={-1}
        className="min-w-0 flex-1 px-5 py-6 sm:px-8"
      >
        <Outlet />
      </main>
    </div>
  );
}
