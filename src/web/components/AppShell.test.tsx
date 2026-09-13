/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AppsPage } from "@web/pages/AppsPage";
import type { StubRoute } from "@web/test-fixtures";
import { HEALTH, installFetch } from "@web/test-fixtures";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

/**
 * Route order matters: the stub takes the first substring match, so every
 * per-provider path has to sit above the bare `/api/connectors` listing.
 */
function baseRoutes(overrides: StubRoute[] = []): StubRoute[] {
  return [
    ...overrides,
    { path: "/api/connectors", data: { connectors: [], health: HEALTH } },
  ];
}

/**
 * The real layout route, with cheap stand-ins for the three pages the shell is
 * not under test with. `AppsPage` is mounted for real because the connect flow
 * is the thing this file is actually guarding.
 */
function renderShell(path: string, routes: StubRoute[] = baseRoutes()) {
  const stub = installFetch(routes);
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<h1>Search stub</h1>} />
          <Route path="pipeline" element={<h1>Pipeline stub</h1>} />
          <Route path="runs" element={<h1>Runs stub</h1>} />
          <Route path="runs/:runId" element={<h1>Runs stub</h1>} />
          <Route path="apps" element={<AppsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return stub;
}

function currentNavLinks() {
  const nav = screen.getByRole("navigation", { name: /sections/i });
  return within(nav)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page");
}

const LINK = {
  redirectUrl: "https://backend.composio.dev/link/abc123",
  expiresAt: "2026-09-13T12:30:00.000Z",
  connectedAccountId: "ca_9",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AppShell", () => {
  it("marks only the section the user is in, including on a nested run URL", async () => {
    renderShell("/runs/run_7");
    await screen.findByText("Runs stub");

    const active = currentNavLinks();
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent("Runs");
  });

  it("moves the marker when the user follows a nav link", async () => {
    renderShell("/");
    await screen.findByText("Search stub");
    expect(currentNavLinks()[0]).toHaveTextContent("Search");

    const nav = screen.getByRole("navigation", { name: /sections/i });
    await act(async () => {
      fireEvent.click(within(nav).getByRole("link", { name: /pipeline/i }));
    });

    expect(screen.getByText("Pipeline stub")).toBeInTheDocument();
    const active = currentNavLinks();
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent("Pipeline");
  });
});

describe("Apps page connect flow", () => {
  it("still offers a usable consent link when the browser blocks the popup", async () => {
    // The silent failure mode: no window, no error, and nothing for the user
    // to click. A blocked popup must not dead-end the demo.
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    renderShell(
      "/apps",
      baseRoutes([
        { method: "POST", path: "/api/connectors/notion/link", data: LINK },
        {
          path: "/api/connectors/notion/status",
          data: { health: HEALTH[1] },
        },
      ]),
    );

    const card = await screen.findByTestId("connect-notion");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));
    });

    const fallback = within(card).getByRole("link", { name: /consent page/i });
    expect(fallback).toHaveAttribute("href", LINK.redirectUrl);
    expect(fallback).toHaveAttribute("target", "_blank");
    expect(within(card).getByText(/blocked the popup/i)).toBeInTheDocument();
  });

  it("stops polling for status once the account comes back connected", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "open",
      vi.fn().mockReturnValue({ closed: false, focus: vi.fn() }),
    );

    const connected = {
      ...HEALTH[1],
      connected: true,
      status: "connected",
      linkState: "active",
      target: "Job Search 2026",
    };
    const stub = renderShell(
      "/apps",
      baseRoutes([
        { method: "POST", path: "/api/connectors/notion/link", data: LINK },
        {
          path: "/api/connectors/notion/status",
          data: { health: connected },
        },
      ]),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const card = screen.getByTestId("connect-notion");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(stub.countOf("GET", "/api/connectors/notion/status")).toBe(1);
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(within(card).getByText("Job Search 2026")).toBeInTheDocument();

    // Five more polling windows: a loop that never stops is the bug.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(stub.countOf("GET", "/api/connectors/notion/status")).toBe(1);
  });

  it("does not disconnect until the user confirms", async () => {
    const stub = renderShell(
      "/apps",
      baseRoutes([
        {
          method: "POST",
          path: "/api/connectors/google_sheets/disconnect",
          data: {
            health: { ...HEALTH[0], connected: false, status: "disconnected" },
          },
        },
      ]),
    );

    const card = await screen.findByTestId("connect-google_sheets");
    fireEvent.click(
      within(card).getByRole("button", { name: /^disconnect$/i }),
    );

    expect(
      stub.countOf("POST", "/api/connectors/google_sheets/disconnect"),
    ).toBe(0);
    expect(
      within(card).getByText(/every row already in it stay/i),
    ).toBeInTheDocument();

    const confirm = within(card).getByRole("button", {
      name: /yes, disconnect/i,
    });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    expect(
      stub.countOf("POST", "/api/connectors/google_sheets/disconnect"),
    ).toBe(1);
    expect(within(card).getByText("Not connected")).toBeInTheDocument();
  });

  it("keeps the connection out of the user's hands until they choose to cancel", async () => {
    const stub = renderShell("/apps");

    const card = await screen.findByTestId("connect-google_sheets");
    fireEvent.click(
      within(card).getByRole("button", { name: /^disconnect$/i }),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: /keep connected/i }),
    );

    expect(
      stub.countOf("POST", "/api/connectors/google_sheets/disconnect"),
    ).toBe(0);
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });

  it("offers the next action instead of a button when a provider has no transport", async () => {
    // The dead end this page had: a card with neither transport still showed
    // Verify connection, whose only possible outcome is an error the user
    // cannot act on. A card must branch on `authMode`, not on its provider.
    renderShell(
      "/apps",
      baseRoutes([
        {
          path: "/api/connectors",
          data: {
            connectors: [],
            health: [
              {
                ...HEALTH[0],
                connected: false,
                status: "disconnected",
                target: null,
                destinationUrl: null,
                lastSyncedAt: null,
                authMode: undefined,
                setupHint:
                  "google_sheets is not connected. Either connect it directly (npm run connect google), or set COMPOSIO_API_KEY in .env.",
              },
              HEALTH[1],
              HEALTH[2],
            ],
          },
        },
      ]),
    );

    const stranded = await screen.findByTestId("connect-google_sheets");
    expect(
      within(stranded).getByText(/npm run connect google/),
    ).toBeInTheDocument();
    expect(
      within(stranded).queryByRole("button", { name: /verify connection/i }),
    ).toBeNull();
    expect(
      within(stranded).queryByRole("button", { name: /^connect$/i }),
    ).toBeNull();
    expect(
      within(stranded).queryByRole("button", { name: /^disconnect$/i }),
    ).toBeNull();

    // Same page, same code path: the hosted-transport card still has its
    // button, so this is transport-driven rather than a blanket removal.
    const hosted = screen.getByTestId("connect-notion");
    expect(
      within(hosted).getByRole("button", { name: /^connect$/i }),
    ).toBeInTheDocument();
  });

  it("probes rather than consents when a provider already has its own credentials", async () => {
    const stub = renderShell(
      "/apps",
      baseRoutes([
        {
          method: "POST",
          path: "/api/connectors/gmail_send/connect",
          data: {
            health: {
              ...HEALTH[2],
              connected: true,
              status: "connected",
              lastError: null,
            },
          },
        },
      ]),
    );

    const card = await screen.findByTestId("connect-gmail_send");
    await act(async () => {
      fireEvent.click(
        within(card).getByRole("button", { name: /verify connection/i }),
      );
    });

    // No consent link is fetched for a direct provider: there is nothing to
    // consent to, only a round trip that proves the stored token still works.
    expect(stub.countOf("POST", "/api/connectors/gmail_send/link")).toBe(0);
    expect(stub.countOf("POST", "/api/connectors/gmail_send/connect")).toBe(1);
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });
});
