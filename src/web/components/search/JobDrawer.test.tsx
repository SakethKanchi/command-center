/** @vitest-environment jsdom */
import type { JobCard } from "@domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { JobDrawer } from "@web/components/search/JobDrawer";
import { describe, expect, it, vi } from "vitest";

function job(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: "j1",
    source: "lever",
    sourceJobId: "abc",
    title: "Staff Platform Engineer",
    company: "Monzo",
    location: "London, UK",
    isRemote: true,
    url: "https://example.test/jobs/1",
    applyUrl: null,
    descriptionText: "Own the deployment platform.",
    contactEmail: null,
    contactEmailSource: null,
    salaryText: "£120k",
    postedAt: "2026-09-11T09:00:00.000Z",
    status: "discovered",
    score: 74,
    scoreReason: "Strong infra overlap, thin on Kafka.",
    brief: null,
    tailoredHeadline: null,
    tailoredSummary: null,
    tailoredSkills: null,
    resumePath: null,
    discoveredAt: "2026-09-12T09:00:00.000Z",
    appliedAt: null,
    updatedAt: "2026-09-12T09:00:00.000Z",
    experienceMinYears: 6,
    experienceMaxYears: null,
    salaryAnnual: 120000,
    locationCountry: "GB",
    locationRegion: "emea",
    tags: [],
    ...overrides,
  };
}

function mount(overrides: Partial<JobCard> = {}) {
  const onClose = vi.fn();
  render(
    <JobDrawer
      job={job(overrides)}
      applying={false}
      applyDisabled={false}
      contactSaving={false}
      onClose={onClose}
      onApply={vi.fn()}
      onSaveContact={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const stops = Array.from(
    dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  );
  return { onClose, dialog, stops };
}

describe("JobDrawer", () => {
  it("traps Tab inside the dialog in both directions", () => {
    const { stops } = mount();
    const first = stops[0] as HTMLElement;
    const last = stops[stops.length - 1] as HTMLElement;
    expect(stops.length).toBeGreaterThan(1);

    // Opening parks focus inside the dialog rather than leaving it on the row.
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on Escape from anywhere, including after focus fell to the body", () => {
    const { onClose } = mount();

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the model's brief when the posting has one", () => {
    mount({
      brief: {
        roleSummary: "Platform team of six, Kubernetes on AWS.",
        mustHaves: ["Kubernetes", "Terraform"],
        niceToHaves: ["Kafka"],
        redFlags: ["On-call every third week"],
      },
    });

    expect(
      screen.getByText("Platform team of six, Kubernetes on AWS."),
    ).toBeInTheDocument();
    expect(screen.getByText("· Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("· On-call every third week")).toBeInTheDocument();
    expect(
      screen.getByText("Strong infra overlap, thin on Kafka."),
    ).toBeInTheDocument();
  });

  it("omits the brief section entirely when there is nothing to show", () => {
    mount({ brief: null });

    expect(screen.queryByText("Model brief")).not.toBeInTheDocument();
    expect(
      screen.getByText("Own the deployment platform."),
    ).toBeInTheDocument();
  });

  it("reads an open-ended experience window as a floor, not a range", () => {
    mount({ experienceMinYears: 6, experienceMaxYears: null });

    expect(screen.getByText("6+ yrs")).toBeInTheDocument();
  });
});
