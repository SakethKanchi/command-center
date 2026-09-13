/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { RUN, RUN_COMPLETED } from "@web/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { RunTrace } from "./RunTrace";

describe("RunTrace", () => {
  it("renders one row per step, each badged with the system it touched", () => {
    render(<RunTrace run={RUN} deciding={null} onDecide={vi.fn()} />);

    for (const step of RUN.steps) {
      const row = screen.getByTestId(`step-${step.seq}`);
      expect(row).toHaveAttribute("data-app", step.app);
      expect(within(row).getByText(step.tool)).toBeInTheDocument();
    }

    expect(
      within(screen.getByTestId("step-1")).getByText("Job boards"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-2")).getByText("LLM"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-4")).getByText("Sheets"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-5")).getByText("Notion"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-6")).getByText("Gmail"),
    ).toBeInTheDocument();
  });

  it("counts the distinct systems the run reached", () => {
    render(<RunTrace run={RUN} deciding={null} onDecide={vi.fn()} />);

    expect(screen.getByTestId("systems-legend")).toHaveTextContent(
      "6 systems touched",
    );
  });

  it("surfaces the ATS verdict and both violation counts for verify_resume", () => {
    render(<RunTrace run={RUN} deciding={null} onDecide={vi.fn()} />);

    const line = screen.getByTestId("verify-line");
    expect(line).toHaveTextContent("ATS 87/100 pass");
    expect(line).toHaveTextContent("0 unsupported claims");
    expect(line).toHaveTextContent("1 style warning");
  });

  it("marks the ATS gate as failed rather than passed when it did not pass", () => {
    const failing = {
      ...RUN,
      steps: RUN.steps.map((step) =>
        step.tool === "verify_resume"
          ? {
              ...step,
              output: {
                ats: { score: 61, passed: false, threshold: 80 },
                fabrications: [
                  { kind: "unsupported_number", claim: "40%", context: "…" },
                ],
                styleWarnings: [],
              },
            }
          : step,
      ),
    };

    render(<RunTrace run={failing} deciding={null} onDecide={vi.fn()} />);

    const line = screen.getByTestId("verify-line");
    expect(line).toHaveTextContent("ATS 61/100 FAIL");
    expect(line).toHaveTextContent("1 unsupported claim");
  });

  it("shows the attempt count only when a step was retried", () => {
    render(<RunTrace run={RUN} deciding={null} onDecide={vi.fn()} />);

    expect(
      within(screen.getByTestId("step-2")).getByText("2 attempts"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-1")).queryByText(/attempts/),
    ).toBeNull();
  });

  it("renders the full drafted email and both decisions while awaiting approval", () => {
    render(<RunTrace run={RUN} deciding={null} onDecide={vi.fn()} />);

    const card = screen.getByTestId("approval-card");
    expect(within(card).getByText("hiring@monzo.com")).toBeInTheDocument();
    expect(
      within(card).getByText("Senior Backend Engineer — Saketh Kanchi"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("approval-body")).toHaveTextContent(
      "I applied for the Senior Backend Engineer role today.",
    );
    expect(
      within(card).getByRole("button", { name: /approve and send/i }),
    ).toBeEnabled();
    expect(within(card).getByRole("button", { name: /^deny$/i })).toBeEnabled();
  });

  it("drops the approval card once the step has been sent", () => {
    render(<RunTrace run={RUN_COMPLETED} deciding={null} onDecide={vi.fn()} />);

    expect(screen.queryByTestId("approval-card")).toBeNull();
    expect(
      within(screen.getByTestId("step-6")).getByText(
        /sent to hiring@monzo.com/i,
      ),
    ).toBeInTheDocument();
  });

  it("reports a failed step with the server's message", () => {
    const failed = {
      ...RUN,
      status: "failed" as const,
      steps: RUN.steps.slice(0, 1).map((step) => ({
        ...step,
        status: "failed" as const,
        errorCode: "UPSTREAM_ERROR",
        errorMessage: "Greenhouse answered 503 after 3 attempts.",
      })),
    };

    render(<RunTrace run={failed} deciding={null} onDecide={vi.fn()} />);

    expect(
      screen.getByText("Greenhouse answered 503 after 3 attempts."),
    ).toBeInTheDocument();
    expect(screen.getByText("UPSTREAM_ERROR")).toBeInTheDocument();
  });
});
