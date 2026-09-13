import { extractExperienceYears } from "@server/search/experience";
import { describe, expect, it } from "vitest";

describe("extractExperienceYears", () => {
  it("reads the phrasings postings actually use", () => {
    const cases: Array<[string, number | null, number | null]> = [
      ["We need 3+ years of experience.", 3, null],
      ["3-5 years of experience required", 3, 5],
      ["3 to 5 years of experience", 3, 5],
      ["Requires at least 4 years of experience", 4, null],
      ["A minimum of 2 years experience in Go", 2, null],
      ["5 yrs experience with Kubernetes", 5, null],
      ["two years of professional experience", 2, null],
      ["10+ years of experience building systems", 10, null],
      ["Up to 3 years of experience is fine", null, 3],
    ];

    for (const [text, minYears, maxYears] of cases) {
      expect(extractExperienceYears(text), text).toEqual({
        minYears,
        maxYears,
      });
    }
  });

  it("ignores year counts that describe history rather than a hiring bar", () => {
    // Each of these used to parse as a requirement and silently bucket the
    // posting into the wrong experience range.
    const notRequirements = [
      "Our founder left Google 5 years ago.",
      "Revenue tripled in the last 3 years.",
      "We have 3 years of runway in the bank.",
      "The company has been profitable for 6 years running.",
    ];

    for (const text of notRequirements) {
      expect(extractExperienceYears(text), text).toEqual({
        minYears: null,
        maxYears: null,
      });
    }
  });

  it("rejects implausible year counts instead of trusting a typo", () => {
    expect(extractExperienceYears("50+ years of experience")).toEqual({
      minYears: null,
      maxYears: null,
    });
    expect(extractExperienceYears("100 years of combined experience")).toEqual({
      minYears: null,
      maxYears: null,
    });
    // The floor survives; only the impossible half is dropped.
    expect(extractExperienceYears("5-99 years of experience")).toEqual({
      minYears: 5,
      maxYears: null,
    });
  });

  it("prefers the number sitting next to an experience cue", () => {
    const text =
      "Founded 2 years ago, we run 6 week sprints and 3 month planning cycles. " +
      "You bring 7+ years of experience shipping backend services.";

    expect(extractExperienceYears(text)).toEqual({
      minYears: 7,
      maxYears: null,
    });
  });

  it("falls back to seniority words only when no number is present", () => {
    expect(extractExperienceYears("Senior Backend Engineer")).toEqual({
      minYears: 5,
      maxYears: null,
    });
    expect(extractExperienceYears("Staff Engineer, Payments")).toEqual({
      minYears: 8,
      maxYears: null,
    });
    expect(extractExperienceYears("Software Engineering Intern")).toEqual({
      minYears: 0,
      maxYears: 1,
    });
    expect(extractExperienceYears("Junior Data Engineer")).toEqual({
      minYears: 0,
      maxYears: 2,
    });
    expect(extractExperienceYears("Mid-Level Platform Engineer")).toEqual({
      minYears: 2,
      maxYears: 5,
    });

    // A stated number outranks the title word, in both directions.
    expect(
      extractExperienceYears("Senior Engineer. 2-4 years of experience."),
    ).toEqual({ minYears: 2, maxYears: 4 });
    expect(
      extractExperienceYears("Junior Engineer with 6+ years of experience"),
    ).toEqual({ minYears: 6, maxYears: null });
  });

  it("does not mistake substrings for seniority words", () => {
    // "Internal" contains "intern"; matching it would file a platform role as
    // an internship.
    expect(extractExperienceYears("Internal Tools Engineer")).toEqual({
      minYears: null,
      maxYears: null,
    });
  });

  it("returns an empty window when the posting says nothing", () => {
    expect(extractExperienceYears("")).toEqual({
      minYears: null,
      maxYears: null,
    });
    expect(
      extractExperienceYears("Build delightful products with a small team."),
    ).toEqual({ minYears: null, maxYears: null });
  });
});
