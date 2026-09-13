import type { ConnectorHealth, ConnectorProvider } from "@domain";
import { ConnectAppCard } from "@web/components/ConnectAppCard";
import { PageHeader } from "@web/components/Header";
import {
  describeError,
  ErrorBanner,
  formatCount,
  Panel,
  PanelHead,
  Skeleton,
} from "@web/components/ui";
import { request } from "@web/lib/api";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "@web/lib/apps";
import { useCallback, useEffect, useState } from "react";

/**
 * The connect surface. Every other page is worthless until this one has been
 * used once, so it says what each app is for, what granting access allows, and
 * exactly what state the connection is in — no hidden OAuth, no silent failure.
 *
 * State lives here rather than in each card because the page-level count has to
 * agree with the cards, and a card that owned its own copy would drift.
 */
export function AppsPage() {
  const [health, setHealth] = useState<ConnectorHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<{ health: ConnectorHealth[] }>(
        "/api/connectors",
      );
      setHealth(result.health);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Cards report health as it changes; merging by provider keeps the order
  // stable so a card never jumps while the user is reading it.
  const mergeHealth = useCallback((next: ConnectorHealth) => {
    setHealth((current) => {
      if (!current) return [next];
      const known = current.some((entry) => entry.provider === next.provider);
      return known
        ? current.map((entry) =>
            entry.provider === next.provider ? next : entry,
          )
        : [...current, next];
    });
  }, []);

  const entries = health ?? [];
  const connected = entries.filter((entry) => entry.connected).length;

  return (
    <>
      <PageHeader
        title="Apps"
        subtitle="Command Center writes to your own accounts, never a copy of them. Each card says which route it is on and gives you the one action that route needs — nothing here asks you to paste an API key into this page."
        actions={
          <span className="u-mono text-[12px] text-ink-dim tabular-nums">
            {formatCount(connected)} of {formatCount(PROVIDER_ORDER.length)}{" "}
            connected
          </span>
        }
      />

      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {loading && !health ? (
        <AppsSkeleton />
      ) : (
        // Stretched, not `items-start`: the cards carry `mt-auto` on their
        // action row, so equal heights put all three Connect buttons on one
        // line instead of stepping down with the prose above them.
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {PROVIDER_ORDER.map((provider) => {
            const entry = entries.find((row) => row.provider === provider);
            return entry ? (
              <ConnectAppCard
                key={provider}
                provider={provider}
                health={entry}
                onHealth={mergeHealth}
              />
            ) : (
              <UnreportedApp key={provider} provider={provider} />
            );
          })}
        </div>
      )}

      <Panel className="mt-6">
        <PanelHead title="What each card can ask of you" />
        <ol className="grid gap-3 px-4 py-4 text-[13.5px] text-ink-dim">
          <li>
            <span className="u-mono mr-2 text-signal tabular-nums">1</span>
            <strong className="font-normal text-ink">Connect</strong> — the app
            is on the hosted route. Command Center asks for a one-time consent
            link and opens it in a new window; you approve on the provider's own
            screen and the card turns green by itself.
          </li>
          <li>
            <span className="u-mono mr-2 text-signal tabular-nums">2</span>
            <strong className="font-normal text-ink">Verify connection</strong>{" "}
            — credentials from <code className="u-mono">npm run connect</code>{" "}
            are already on disk. Nothing opens: this round-trips the provider to
            prove the token still works.
          </li>
          <li>
            <span className="u-mono mr-2 text-signal tabular-nums">3</span>
            <strong className="font-normal text-ink">No button</strong> — that
            app has no route yet. The card names the single command or key that
            gives it one, and grows a button once the server reports a
            transport.
          </li>
        </ol>
        <p className="border-t border-ridge px-4 py-3 text-[13px] text-ink-faint">
          Your password never reaches this app, and disconnecting deletes
          nothing in the external account.
        </p>
      </Panel>
    </>
  );
}

/**
 * The server promises one entry per provider, so this is a contract breach
 * rather than an empty state — which is worth saying out loud instead of
 * rendering a card with invented defaults.
 */
function UnreportedApp({ provider }: { provider: ConnectorProvider }) {
  const meta = PROVIDER_PRESENTATION[provider];
  return (
    <article className="panel px-4 py-3" data-testid={`connect-${provider}`}>
      <h3 className="u-display text-[15px] leading-none text-ink">
        {meta.label}
      </h3>
      <p className="mt-2 text-[13px] text-ink-dim">{meta.purpose}</p>
      <p className="u-mono mt-3 text-[11.5px] text-ink-faint">
        The server did not report this app. Restart it and reload.
      </p>
    </article>
  );
}

/** Three cards, same grid, same heights: nothing shifts when health lands. */
function AppsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {PROVIDER_ORDER.map((provider) => (
        <section key={provider} className="panel">
          <header className="flex items-start justify-between gap-3 border-b border-ridge px-4 py-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-2.5 h-2.5 w-full max-w-[15rem]" />
            </div>
            <Skeleton className="h-4 w-14 shrink-0" />
          </header>
          <div className="flex flex-col gap-3 px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-40" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-7 w-24" />
            </div>
          </div>
        </section>
      ))}
      <p className="u-mono col-span-full text-[11.5px] text-ink-faint">
        Checking your apps…
      </p>
    </div>
  );
}
