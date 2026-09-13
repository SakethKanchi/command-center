/** @vitest-environment jsdom */
import type { AppSettings } from "@domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "@web/pages/SettingsPage";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The settings screen.
 *
 * What is asserted here is what a user can be misled by: where a value came
 * from, that a key is never echoed back into the page, that saving the model
 * does not silently clear the key, and that a refused provider is reported
 * rather than swallowed.
 */

const SETTINGS: AppSettings = {
  llm: {
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlSource: "default",
    model: "anthropic/claude-sonnet-4.5",
    modelSource: "env",
    apiKeyConfigured: true,
    apiKeySource: "env",
    apiKeyHint: "9f2c",
  },
  agent: { fitMinScore: 20, atsMinScore: 70, followUpDelayDays: 5 },
};

const BOUNDS = {
  fitMinScore: { min: 0, max: 100 },
  atsMinScore: { min: 50, max: 100 },
  followUpDelayDays: { min: 1, max: 60 },
};

/** Every request the page issued: method, path and parsed body. */
let sent: Array<{ method: string; url: string; body: unknown }> = [];
let settings: AppSettings;
let modelsReply: { status: number; body: unknown };
let testReply: { status: number; body: unknown };

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" && init.body !== ""
          ? JSON.parse(init.body)
          : null;
      sent.push({ method, url, body });

      const json = (status: number, payload: unknown) =>
        ({ status, json: async () => payload }) as unknown as Response;

      if (url.startsWith("/api/settings/llm/models")) {
        return json(modelsReply.status, modelsReply.body);
      }
      if (url === "/api/settings/llm/test") {
        return json(testReply.status, testReply.body);
      }
      if (url === "/api/settings/llm" && method === "PATCH") {
        const patch = body as Record<string, string | null>;
        settings = {
          ...settings,
          llm: {
            ...settings.llm,
            ...(patch.model === undefined
              ? {}
              : { model: patch.model ?? "env/model", modelSource: "setting" }),
            ...(patch.apiKey === null
              ? { apiKeyConfigured: false, apiKeyHint: null }
              : {}),
          },
        };
        return json(200, { ok: true, data: { llm: settings.llm } });
      }
      if (url === "/api/settings/agent" && method === "PATCH") {
        const patch = body as Partial<AppSettings["agent"]>;
        settings = { ...settings, agent: { ...settings.agent, ...patch } };
        return json(200, { ok: true, data: { agent: settings.agent } });
      }
      return json(200, {
        ok: true,
        data: { settings, bounds: BOUNDS },
      });
    }),
  );
}

function mount() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  // The panels carry `aria-labelledby`, so a bare label query would match the
  // section as well as its input; every query here names the control.
  return screen.findByLabelText("Provider base URL");
}

beforeEach(() => {
  sent = [];
  settings = structuredClone(SETTINGS);
  modelsReply = {
    status: 200,
    body: { ok: true, data: { models: [{ id: "a/model", label: "A" }] } },
  };
  testReply = {
    status: 200,
    body: {
      ok: true,
      data: {
        ok: true,
        model: "a/model",
        message: "a/model answered in 42ms.",
      },
    },
  };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("says where each effective value came from", async () => {
    await mount();

    expect(screen.getAllByText("from .env").length).toBeGreaterThan(0);
    expect(screen.getByText("built-in default")).toBeInTheDocument();
  });

  it("shows only the tail of a configured key and never its value", async () => {
    await mount();

    expect(screen.getByText(/ending 9f2c/)).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("saves the model without touching an untyped key", async () => {
    await mount();

    fireEvent.change(screen.getByLabelText("Model", { selector: "input" }), {
      target: { value: "openai/gpt-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save model/i }));

    await waitFor(() =>
      expect(screen.getByTestId("model-state")).toHaveTextContent(/Saved/),
    );
    const patch = sent.find((entry) => entry.url === "/api/settings/llm");
    expect(patch?.body).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5",
    });
    expect(screen.getByText(/ending 9f2c/)).toBeInTheDocument();
  });

  it("lists models for the base URL currently in the field", async () => {
    await mount();

    fireEvent.change(screen.getByLabelText("Provider base URL"), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /list models/i }));

    await waitFor(() =>
      expect(screen.getByTestId("model-options")).toBeInTheDocument(),
    );
    const listed = sent.find((entry) =>
      entry.url.startsWith("/api/settings/llm/models"),
    );
    expect(listed?.url).toContain(
      encodeURIComponent("http://localhost:11434/v1"),
    );
  });

  it("keeps a provider that has no model list editable", async () => {
    modelsReply = {
      status: 502,
      body: {
        ok: false,
        error: { code: "UPSTREAM", message: "The provider answered 404." },
      },
    };
    await mount();

    fireEvent.click(screen.getByRole("button", { name: /list models/i }));

    await waitFor(() =>
      expect(screen.getByText(/answered 404/)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Model", { selector: "input" })).toBeEnabled();
  });

  it("reports a refused connection test", async () => {
    testReply = {
      status: 200,
      body: {
        ok: true,
        data: { ok: false, model: "a/model", message: "Invalid API key." },
      },
    };
    await mount();

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() =>
      expect(screen.getByTestId("connection-result")).toHaveTextContent(
        "Invalid API key.",
      ),
    );
  });

  it("saves the three thresholds as numbers", async () => {
    await mount();

    fireEvent.change(screen.getByLabelText("ATS floor"), {
      target: { value: "85" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save thresholds/i }));

    await waitFor(() =>
      expect(screen.getByTestId("threshold-state")).toHaveTextContent(/Saved/),
    );
    expect(
      sent.find((entry) => entry.url === "/api/settings/agent")?.body,
    ).toEqual({
      fitMinScore: 20,
      atsMinScore: 85,
      followUpDelayDays: 5,
    });
  });

  it("surfaces a rejected threshold instead of pretending it saved", async () => {
    await mount();
    vi.mocked(fetch).mockImplementationOnce(
      async () =>
        ({
          status: 400,
          json: async () => ({
            ok: false,
            error: { code: "INVALID_REQUEST", message: "Too low." },
          }),
        }) as unknown as Response,
    );

    fireEvent.change(screen.getByLabelText("ATS floor"), {
      target: { value: "51" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save thresholds/i }));

    await waitFor(() =>
      expect(screen.getByTestId("threshold-error")).toHaveTextContent(
        "Too low.",
      ),
    );
    expect(screen.getByTestId("threshold-state")).toHaveTextContent(
      "Unsaved changes",
    );
  });
});
