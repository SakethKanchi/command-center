/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { RoleSuggestions } from "@web/components/search/RoleSuggestions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The contract this row owes the user: a saved resume produces suggestions
 * without anyone asking, and an unsaved one produces nothing at all — never a
 * set generated from the committed seed profile, which belongs to somebody
 * else.
 */

type Answer = {
  suggestions: Array<{ title: string; query: string; reason: string }>;
  generatedAt: string | null;
  stale: boolean;
  profileSource: "stored" | "seed";
};

let get: Answer;
let post: Answer;
let calls: Array<{ method: string }>;

function installFetch() {
  const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== "/api/profile/role-suggestions") {
      throw new Error(`No stub route for ${url}`);
    }
    const method = init?.method ?? "GET";
    calls.push({ method });
    return {
      status: 200,
      json: async () => ({ ok: true, data: method === "POST" ? post : get }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
}

const COMPILER = {
  title: "Compiler Engineer",
  query: "compiler engineer",
  reason: "Built A-0 at Eckert-Mauchly.",
};

beforeEach(() => {
  calls = [];
  get = {
    suggestions: [],
    generatedAt: null,
    stale: false,
    profileSource: "seed",
  };
  post = {
    suggestions: [COMPILER],
    generatedAt: "2026-09-12T09:00:00.000Z",
    stale: false,
    profileSource: "stored",
  };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoleSuggestions", () => {
  it("generates from a newly saved resume without being asked", async () => {
    get = {
      suggestions: [],
      generatedAt: null,
      stale: true,
      profileSource: "stored",
    };

    render(<RoleSuggestions activeQuery="" onPick={vi.fn()} />);

    expect(await screen.findByText("Compiler Engineer")).toBeTruthy();
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("stays silent, and spends no model call, when no resume has been saved", async () => {
    render(<RoleSuggestions activeQuery="" onPick={vi.fn()} />);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("GET");
    expect(screen.queryByText("Suggested for you")).toBeNull();
  });

  it("serves a fresh stored set as-is, without regenerating it", async () => {
    get = {
      suggestions: [COMPILER],
      generatedAt: "2026-09-12T09:00:00.000Z",
      stale: false,
      profileSource: "stored",
    };

    render(
      <RoleSuggestions activeQuery="compiler engineer" onPick={vi.fn()} />,
    );

    const chip = await screen.findByTestId("role-suggestion-compiler engineer");
    // The chip reads as picked when its query is the one in the URL.
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});
