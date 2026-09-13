import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatElapsed,
  formatRelative,
  humanize,
  truncate,
} from "./format";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");

describe("formatDuration", () => {
  it("switches unit at the millisecond, second and minute boundaries", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(59_900)).toBe("59.9s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(92_400)).toBe("1m 32s");
  });

  it("renders a dash rather than NaN when a step never recorded one", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatRelative", () => {
  it("reads past and future from the same value", () => {
    expect(formatRelative("2026-09-13T11:58:00.000Z", NOW)).toBe("2m ago");
    expect(formatRelative("2026-09-13T12:30:00.000Z", NOW)).toBe("in 30m");
    expect(formatRelative("2026-09-11T12:00:00.000Z", NOW)).toBe("2d ago");
    expect(formatRelative("2026-09-13T11:59:59.000Z", NOW)).toBe("just now");
  });

  it("does not invent a time for a missing or malformed value", () => {
    expect(formatRelative(null, NOW)).toBe("—");
    expect(formatRelative("not a date", NOW)).toBe("—");
  });
});

describe("formatElapsed", () => {
  it("measures a finished run end to end and a live one against now", () => {
    expect(
      formatElapsed(
        "2026-09-13T11:59:15.000Z",
        "2026-09-13T11:59:57.500Z",
        NOW,
      ),
    ).toBe("42.5s");
    expect(formatElapsed("2026-09-13T11:59:30.000Z", null, NOW)).toBe("30.0s");
  });
});

describe("humanize", () => {
  it("turns a stored enum into a sentence-case label", () => {
    expect(humanize("recruiter_screen")).toBe("Recruiter screen");
    expect(humanize("offer")).toBe("Offer");
    expect(humanize(null)).toBe("—");
  });
});

describe("truncate", () => {
  it("keeps the budget including the ellipsis", () => {
    expect(truncate("abcdefghij", 10)).toBe("abcdefghij");
    expect(truncate("abcdefghijk", 10)).toBe("abcdefghi…");
  });
});
