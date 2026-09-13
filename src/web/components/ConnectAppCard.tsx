import type { ConnectorHealth, ConnectorProvider } from "@domain";
import { request } from "@web/lib/api";
import { PROVIDER_PRESENTATION } from "@web/lib/apps";
import { formatDateTime } from "@web/lib/format";
import { ExternalLink, Loader2, PlugZap, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusTone } from "./ui";
import { AppChip, DeepLink, describeError, StatusBadge } from "./ui";

/** Composio's hosted consent screen, and the window we point the user at. */
type ConnectLink = {
  redirectUrl: string;
  expiresAt: string;
  connectedAccountId: string;
};

const POLL_MS = 2000;

/**
 * Consent screens get abandoned. Without a ceiling the tab keeps a request
 * every two seconds alive forever, which is the kind of thing that only shows
 * up as a mystery during a demo.
 */
const POLL_CEILING_MS = 3 * 60_000;

type Phase = "idle" | "starting" | "waiting" | "verifying" | "disconnecting";

/**
 * `linkState` is the authority while a consent flow is open: `pending` means
 * the user is still on Composio's screen. Falling back to `status` covers the
 * direct-OAuth providers, which never populate a link state at all.
 */
function isSettled(health: ConnectorHealth): boolean {
  if (health.linkState === "pending") return false;
  if (health.linkState) return true;
  return health.status === "connected" || health.status === "error";
}

export function ConnectAppCard({
  provider,
  health,
  onHealth,
}: {
  provider: ConnectorProvider;
  health: ConnectorHealth;
  /** Lifts the fresh health up so the shell's connected counter agrees. */
  onHealth: (next: ConnectorHealth) => void;
}) {
  const meta = PROVIDER_PRESENTATION[provider];
  const [phase, setPhase] = useState<Phase>("idle");
  const [link, setLink] = useState<ConnectLink | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const popup = useRef<Window | null>(null);

  // A second click must not open a second consent window or start a second
  // poll loop; state is batched, a ref settles now.
  const busy = useRef(false);

  const connecting = phase === "starting" || phase === "waiting";

  // The transport the server says this provider is on, and the only thing the
  // action row is allowed to branch on. A provider allowlist here would go
  // stale the moment a toolkit gains or loses a Composio transport, and the
  // card would offer a button that cannot work — or hide one that can.
  //
  // `direct` means credentials are already on disk, so the action is a probe.
  // An absent mode means neither transport is set up: there is nothing to
  // press, and pretending otherwise is the dead end this card had.
  const direct = health.authMode === "direct";
  const connectable = Boolean(health.authMode) || health.connected;

  const [tone, statusLabel]: [StatusTone, string] = health.connected
    ? ["pass", "Connected"]
    : connecting
      ? ["signal", "Connecting…"]
      : health.status === "error"
        ? ["alarm", "Error"]
        : ["muted", "Not connected"];

  const accountLabel = health.target ?? health.connectedAccountId ?? null;
  const hint = health.setupHint ?? meta.setupHint;

  // An app that was never set up is the expected starting state, not a fault.
  // Red is reserved for one that was connected and then broke, or for a step
  // the user just took that failed — otherwise a first run reads as three
  // errors before the user has done anything at all.
  const problem =
    failure ?? (health.status === "error" ? health.lastError : null);

  // Seven exits share these two lines, and forgetting the ref release is what
  // would leave the card permanently unclickable.
  const stopFlow = useCallback(() => {
    setPhase("idle");
    busy.current = false;
  }, []);

  const handleConnect = async () => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    setPopupBlocked(false);
    setPhase(direct ? "verifying" : "starting");

    try {
      if (direct) {
        // Credentials already on disk: there is nothing to consent to, only a
        // round trip to prove they still work.
        const result = await request<{ health: ConnectorHealth }>(
          `/api/connectors/${provider}/connect`,
          { method: "POST", body: JSON.stringify({}) },
        );
        onHealth(result.health);
        stopFlow();
        return;
      }

      const started = await request<ConnectLink>(
        `/api/connectors/${provider}/link`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setLink(started);

      const opened = window.open(
        started.redirectUrl,
        `connect-${provider}`,
        "popup,width=520,height=720",
      );
      // A blocked popup is the quiet demo killer: no window, no error, no
      // consent. Record it so the card can show the same URL as a link the
      // user can click themselves, and keep polling either way.
      if (opened) opened.focus?.();
      else setPopupBlocked(true);
      popup.current = opened;

      setPhase("waiting");
    } catch (cause) {
      setFailure(describeError(cause));
      stopFlow();
    }
  };

  const handleDisconnect = async () => {
    if (busy.current) return;
    busy.current = true;
    setConfirming(false);
    setFailure(null);
    setPhase("disconnecting");
    try {
      const result = await request<{ health: ConnectorHealth }>(
        `/api/connectors/${provider}/disconnect`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onHealth(result.health);
      setLink(null);
      setPopupBlocked(false);
    } catch (cause) {
      setFailure(describeError(cause));
    } finally {
      stopFlow();
    }
  };

  // Consent happens in another window, so the only way to learn the outcome is
  // to ask. Three independent stop conditions: a settled account, the user
  // closing the window, and the ceiling.
  useEffect(() => {
    if (phase !== "waiting") return;
    const deadline = Date.now() + POLL_CEILING_MS;
    let cancelled = false;

    const timer = setInterval(() => {
      void (async () => {
        let next: ConnectorHealth;
        try {
          const result = await request<{ health: ConnectorHealth }>(
            `/api/connectors/${provider}/status`,
          );
          next = result.health;
        } catch (cause) {
          if (cancelled) return;
          setFailure(describeError(cause));
          stopFlow();
          return;
        }
        if (cancelled) return;

        onHealth(next);
        if (isSettled(next)) {
          stopFlow();
          return;
        }
        // The poll above already fetched the final state, so stopping here
        // cannot lose a consent the user completed just before closing.
        if (popup.current?.closed) {
          setFailure(
            "The consent window closed before access was granted. Connect again to retry.",
          );
          stopFlow();
          return;
        }
        if (Date.now() >= deadline) {
          setFailure("Timed out waiting for consent. Connect again to retry.");
          stopFlow();
        }
      })();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, provider, onHealth, stopFlow]);

  return (
    <article
      className="panel flex flex-col"
      data-app={meta.app}
      data-testid={`connect-${provider}`}
      aria-busy={connecting || phase === "disconnecting"}
    >
      <header className="flex items-start justify-between gap-3 border-b border-ridge px-4 py-3">
        <div className="min-w-0">
          <h3 className="u-display text-[15px] leading-none text-ink">
            {meta.label}
          </h3>
          <p className="mt-2 text-[13px] text-ink-dim">{meta.purpose}</p>
        </div>
        <AppChip app={meta.app} />
      </header>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusBadge tone={tone} label={statusLabel} spin={connecting} />
          {health.connected && health.lastSyncedAt ? (
            <span className="u-mono text-[11px] text-ink-faint tabular-nums">
              Synced {formatDateTime(health.lastSyncedAt)}
            </span>
          ) : null}
        </div>

        {accountLabel ? (
          <p
            className="u-mono truncate text-[12px] text-ink"
            title={accountLabel}
          >
            {accountLabel}
          </p>
        ) : null}

        {health.connected && health.destinationUrl ? (
          <DeepLink href={health.destinationUrl}>Open in {meta.label}</DeepLink>
        ) : null}

        {!health.connected && !connecting ? (
          <p className="text-[13px] text-ink-faint">{meta.consentNote}</p>
        ) : null}

        {connecting ? (
          <p className="text-[13px] text-ink-dim">
            Approve access in the {meta.label} window, then come back — this
            card updates itself.
          </p>
        ) : null}

        {/* The escape hatch. `window.open` can be refused without telling the
            page anything, so the redirect has to stay reachable as a plain
            link the user can click, Cmd-click or copy. */}
        {popupBlocked && link ? (
          <div className="rounded-sm border border-signal/50 bg-signal/10 px-3 py-2.5">
            <p className="text-[13px] text-ink">
              Your browser blocked the popup.
            </p>
            <a
              href={link.redirectUrl}
              target="_blank"
              rel="noreferrer"
              className="u-mono mt-1.5 inline-flex items-center gap-1.5 rounded-sm text-[12px] text-signal underline decoration-signal/50 underline-offset-3 hover:decoration-signal"
            >
              Open the {meta.label} consent page
              <ExternalLink className="size-3" aria-hidden />
            </a>
            <p className="u-mono mt-1.5 text-[11px] text-ink-faint tabular-nums">
              Link valid until {formatDateTime(link.expiresAt)}
            </p>
          </div>
        ) : null}

        {/* `alert` only for something that just happened: three cards each
            announcing a pre-existing error on first paint is noise, not help. */}
        {problem ? (
          <p
            role={failure ? "alert" : undefined}
            className="rounded-sm border border-alarm/40 bg-alarm/10 px-3 py-2 text-[13px] text-alarm"
          >
            {problem}
          </p>
        ) : null}

        {connectable && !health.connected && !connecting && !problem && hint ? (
          <p className="u-mono text-[11.5px] text-ink-faint">{hint}</p>
        ) : null}

        {confirming ? (
          <div className="mt-auto rounded-sm border border-ridge-hi bg-panel-hi px-3 py-2.5">
            <p className="text-[13px] text-ink">Disconnect {meta.label}?</p>
            <p className="mt-1 text-[13px] text-ink-dim">
              {meta.retentionNote} Nothing is deleted.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDisconnect()}
              >
                Yes, disconnect
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirming(false)}
              >
                Keep connected
              </button>
            </div>
          </div>
        ) : !connectable ? (
          /* Neither transport configured. One sentence naming the one thing
             that changes that beats a button whose only possible outcome is an
             error the user cannot act on. */
          <div className="mt-auto rounded-sm border border-ridge-hi bg-panel-hi px-3 py-2.5">
            <p className="text-[13px] text-ink">
              Nothing to press yet — one step first:
            </p>
            <p className="u-mono mt-1.5 text-[12px] text-ink-dim">{hint}</p>
          </div>
        ) : (
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleConnect()}
              disabled={phase !== "idle"}
            >
              {connecting || phase === "verifying" ? (
                <Loader2 className="spin size-3.5" aria-hidden />
              ) : health.connected ? (
                <RotateCw className="size-3.5" aria-hidden />
              ) : (
                <PlugZap className="size-3.5" aria-hidden />
              )}
              {connecting
                ? "Connecting…"
                : phase === "verifying"
                  ? "Checking…"
                  : health.connected
                    ? "Reconnect"
                    : direct
                      ? "Verify connection"
                      : "Connect"}
            </button>

            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirming(true)}
              disabled={!health.connected || phase !== "idle"}
            >
              {phase === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
