/**
 * Everything search reads, derived once at write time.
 *
 * Kept in its own module so the jobs repository can populate these without
 * importing the query layer that reads them.
 */

import type { JobRegion, JobTag } from "@domain";
import { extractContactEmail } from "./contact";
import { extractExperienceYears } from "./experience";
import { locationCountry, locationSegments } from "./location";
import { regionForCountry } from "./regions";
import { parseSalaryValue } from "./salary";
import { extractJobTags } from "./tags";

export type JobSearchFields = {
  /** Lowercased `title | company | location | description`. */
  searchBlob: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  /**
   * Top of the published range, annualized. Derived here rather than parsed on
   * every read because a pay floor has to be a SQL predicate: no expression
   * over `salary_text` can compare "$180k - $220k" to a number.
   */
  salaryAnnual: number | null;
  /**
   * ISO alpha-2 read out of the place text, and the macro region it sits in.
   * Derived at write time for the same reason as the pay: a country rollup has
   * to be a GROUP BY, and no SQL expression can read "Toronto, Canada" as CA.
   */
  locationCountry: string | null;
  locationRegion: JobRegion | null;
  /**
   * The outreach recipient the posting names, or null when it names none.
   * Derived here so a search row can state whether outreach is possible at
   * all, and so re-parsing the corpus picks up extractor changes.
   */
  contactEmail: string | null;
  tags: JobTag[];
};

export type JobSearchSource = {
  title: string;
  company: string;
  location?: string | null;
  descriptionText?: string | null;
  salaryText?: string | null;
};

export function buildJobSearchFields(job: JobSearchSource): JobSearchFields {
  const description = job.descriptionText ?? "";
  const experience = extractExperienceYears(`${job.title}\n${description}`);
  // One parse of the place string, shared by the country and the region: the
  // region is a function of the country, so deriving it twice would let the
  // two disagree.
  const country = locationCountry(locationSegments(job.location ?? ""));

  return {
    // Whitespace is collapsed because a quoted phrase search is a literal
    // substring match: without this, `"staff engineer"` misses every posting
    // that happened to wrap the title across two lines.
    searchBlob: [job.title, job.company, job.location ?? "", description]
      .join(" | ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
    experienceMinYears: experience.minYears,
    experienceMaxYears: experience.maxYears,
    salaryAnnual: parseSalaryValue(job.salaryText),
    locationCountry: country,
    locationRegion: regionForCountry(country),
    contactEmail: extractContactEmail(description),
    tags: extractJobTags({ title: job.title, descriptionText: description }),
  };
}
