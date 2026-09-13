import { AppShell } from "@web/components/AppShell";
import { AppsPage } from "@web/pages/AppsPage";
import { PipelinePage } from "@web/pages/PipelinePage";
import { ProfilePage } from "@web/pages/ProfilePage";
import { RunsPage } from "@web/pages/RunsPage";
import { SearchPage } from "@web/pages/SearchPage";
import { SettingsPage } from "@web/pages/SettingsPage";
import { Link, Route, Routes } from "react-router-dom";

/**
 * Six destinations under one layout route, so the sidebar mounts once and
 * survives navigation. `/runs` and `/runs/:runId` are the same screen with and
 * without a selection rather than two components.
 */
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<SearchPage />} />
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunsPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="apps" element={<AppsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/**
 * A wrong URL is usually a stale bookmark, so it says which URL failed instead
 * of redirecting silently and leaving the user wondering what they clicked.
 */
function NotFound() {
  return (
    <>
      <h1 className="u-display text-[1.5rem] leading-none text-ink">
        No such page
      </h1>
      <p className="mt-3 max-w-[60ch] text-ink-dim">
        <code className="u-mono text-ink">{window.location.pathname}</code> is
        not one of the six sections. Profile, Search, Pipeline, Runs, Apps and
        Settings are in the sidebar.
      </p>
      <p className="mt-4">
        <Link to="/" className="btn btn-primary">
          Go to search
        </Link>
      </p>
    </>
  );
}
