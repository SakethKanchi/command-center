/** @vitest-environment jsdom */
import { RESUME_TEMPLATES } from "@domain";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TemplatePicker } from "@web/components/profile/TemplatePicker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The template picker.
 *
 * The choice is a write, so the tests are about what reaches the server and
 * what the user is left looking at when it does not: a radio that stays on a
 * template the server never accepted would tell someone their resume renders
 * one way when the agent would render it another.
 */

/** Every PUT body the picker sent, in order. */
let puts: string[] = [];
let putStatus = 200;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (status: number, body: unknown) =>
        ({ status, json: async () => body }) as unknown as Response;

      if (url === "/api/resume/templates") {
        return json(200, {
          ok: true,
          data: { templates: RESUME_TEMPLATES, selected: "compact" },
        });
      }
      if (url === "/api/resume/template" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { template: string };
        puts.push(body.template);
        return putStatus === 200
          ? json(200, { ok: true, data: { selected: body.template } })
          : json(putStatus, {
              ok: false,
              error: { code: "INVALID_REQUEST", message: "Unknown template." },
            });
      }
      throw new Error(`No stub route for ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

async function mount(ready = true, dirty = false) {
  const view = render(<TemplatePicker ready={ready} dirty={dirty} />);
  await screen.findByTestId("template-ats");
  return view;
}

const radio = (id: string) =>
  screen
    .getByTestId(`template-${id}`)
    .querySelector("input") as HTMLInputElement;

beforeEach(() => {
  puts = [];
  putStatus = 200;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TemplatePicker", () => {
  it("shows the catalogue with the stored selection checked", async () => {
    await mount();

    expect(screen.getAllByRole("radio")).toHaveLength(RESUME_TEMPLATES.length);
    expect(radio("compact").checked).toBe(true);
    expect(screen.getByText(/Times-metric serif/)).toBeInTheDocument();
  });

  it("saves a new choice immediately", async () => {
    await mount();

    await act(async () => {
      fireEvent.click(radio("classic"));
    });

    expect(puts).toEqual(["classic"]);
    expect(radio("classic").checked).toBe(true);
  });

  it("puts the radio back where it was when the save fails", async () => {
    putStatus = 400;
    await mount();

    await act(async () => {
      fireEvent.click(radio("ats"));
    });

    expect(puts).toEqual(["ats"]);
    // The server still renders `compact`; showing `ats` selected would be a lie.
    expect(radio("compact").checked).toBe(true);
    expect(screen.getByTestId("template-error")).toHaveTextContent(
      "Unknown template.",
    );
  });

  it("previews the selected template and follows a change of selection", async () => {
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /preview pdf/i }));
    });
    const frame = screen.getByTitle("Resume preview (compact)");
    expect(frame.getAttribute("src")).toContain("template=compact");

    await act(async () => {
      fireEvent.click(radio("classic"));
    });
    expect(
      screen.getByTitle("Resume preview (classic)").getAttribute("src"),
    ).toContain("template=classic");
  });

  it("refuses to preview an incomplete profile", async () => {
    await mount(false);

    expect(screen.getByRole("button", { name: /preview pdf/i })).toBeDisabled();
    expect(screen.getByText(/needs a complete profile/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
  });
});
