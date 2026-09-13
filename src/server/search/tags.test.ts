import { classifyLevel, extractJobTags } from "@server/search/tags";
import { describe, expect, it } from "vitest";

/**
 * The extractor is keyword matching, which is exactly the technique that
 * produces confident nonsense: "Go above and beyond" is not a Go role, and
 * "no visa sponsorship" contains the phrase that would otherwise advertise
 * one. These cases pin the rules that stop a tag from lying, because a filter
 * whose tags can lie is worse than no filter.
 */

describe("classifyLevel", () => {
  it("reads the highest rung a compound title states", () => {
    // Leftmost-wins would call this senior. It is a staff role whose title
    // happens to open with "Senior".
    expect(classifyLevel("Senior Staff Software Engineer")).toBe("staff");
    expect(classifyLevel("Principal Engineer, Platform")).toBe("principal");
    expect(classifyLevel("Sr. Backend Developer")).toBe("senior");
    expect(classifyLevel("New Grad Software Engineer")).toBe("junior");
  });

  it("states no level rather than guessing one", () => {
    expect(classifyLevel("Software Engineer")).toBeNull();
    expect(classifyLevel("Backend Developer, Payments")).toBeNull();
  });

  it("does not file the person running an internship as an intern", () => {
    expect(classifyLevel("Intern Program Manager")).toBeNull();
    expect(classifyLevel("Internship Programme Coordinator")).toBeNull();
    expect(classifyLevel("Software Engineering Intern")).toBe("intern");
  });
});

describe("extractJobTags", () => {
  it("does not let one technology's spelling match another's", () => {
    expect(
      extractJobTags({ title: "Dev", descriptionText: "JavaScript and CSS" }),
    ).toEqual(["skill:javascript", "skill:css"]);
    // "java" is a prefix of "javascript"; a substring match would tag both.
    expect(
      extractJobTags({ title: "Dev", descriptionText: "JavaScript" }),
    ).not.toContain("skill:java");
  });

  it("keeps punctuation-bearing names matchable", () => {
    expect(
      extractJobTags({
        title: "Engineer",
        descriptionText: "C++ and C# on .NET, plus CI/CD and Node.js.",
      }),
    ).toEqual([
      "skill:csharp",
      "skill:cpp",
      "skill:nodejs",
      "skill:dotnet",
      "skill:ci_cd",
    ]);
  });

  it("ignores an ambiguous word used in its ordinary English sense", () => {
    expect(
      extractJobTags({
        title: "Engineer",
        descriptionText: "You go above and beyond and express your ideas.",
      }),
    ).toEqual([]);
    expect(
      extractJobTags({ title: "Golang Engineer", descriptionText: "" }),
    ).toEqual(["skill:go"]);
  });

  it("reports a sponsorship refusal rather than the phrase inside it", () => {
    expect(
      extractJobTags({
        title: "Engineer",
        descriptionText: "No visa sponsorship is available for this role.",
      }),
    ).toEqual(["eligibility:no_sponsorship"]);
    expect(
      extractJobTags({
        title: "Engineer",
        descriptionText: "We will sponsor visas for the right candidate.",
      }),
    ).toEqual(["eligibility:visa_sponsorship"]);
    // Silence is neither answer, and must not read as either.
    expect(
      extractJobTags({ title: "Engineer", descriptionText: "Great team." }),
    ).toEqual([]);
  });

  it("carries both employment types when a posting offers both", () => {
    expect(
      extractJobTags({
        title: "Engineer",
        descriptionText: "Full-time or contract role, your choice.",
      }),
    ).toEqual(["employment:full_time", "employment:contract"]);
  });

  it("does not read a contract role out of the word contract", () => {
    expect(
      extractJobTags({
        title: "Counsel",
        descriptionText: "You will handle contract negotiation and renewals.",
      }),
    ).toEqual([]);
  });
});
